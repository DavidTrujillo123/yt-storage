/**
 * Captures a YouTube cookie jar by driving a browser on this machine, so the
 * setup wizard can finish with a button instead of a command someone has to
 * paste into a terminal.
 *
 * A private window cannot be used for this, and no amount of flags changes it:
 * its cookies live only in memory and are never written to disk, so there is
 * nothing for anything to read. What happens instead has the same property by
 * other means — the browser is launched against a brand new throwaway profile
 * directory, and that directory is deleted once the jar is out.
 *
 * The disposability is the whole point rather than a tidy-up. Google rotates
 * session cookies on use, so a jar copied out of a profile that stays signed in
 * is rotated by two clients at once and dies within minutes. Nothing ever opens
 * this profile again, so its session stays whole.
 *
 * Only works when the API process shares a machine — and a graphical session —
 * with the browser. `captureCapability()` is what the UI asks before offering
 * the button, and `scripts/get-cookies.mjs` remains the answer when it says no.
 */
import { Logger } from '@nestjs/common';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSessionCookie } from './cookie-jar';

/** How long someone gets to complete a Google sign-in before we give up. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Short because the check behind it is a file read, not a subprocess. It is
 * also how quickly a cancel takes effect, since that is only noticed between
 * two polls.
 */
const POLL_MS = 1000;
/** Chromium only guarantees a cookie flush on a clean exit; this is that wait. */
const FLUSH_MS = 3000;

/**
 * Only Chromium-family browsers can be driven this way: the throwaway profile
 * is a `--user-data-dir`, and yt-dlp reads the jar back out of that directory.
 * macOS keeps them in .app bundles; elsewhere they are on PATH.
 *
 * `bundleId` and `desktop` are how the OS names the same browser when asked
 * which one handles https, and are what make "the default browser" resolvable.
 */
interface BrowserSpec {
  name: string;
  darwin: string;
  linux: string[];
  bundleId: string;
  desktop: string[];
}

const BROWSERS: Record<string, BrowserSpec> = {
  brave: {
    name: 'Brave',
    darwin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    linux: ['brave-browser', 'brave', 'brave-browser-stable'],
    bundleId: 'com.brave.browser',
    desktop: ['brave-browser.desktop', 'brave.desktop', 'brave_brave.desktop'],
  },
  chrome: {
    name: 'Google Chrome',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: ['google-chrome', 'google-chrome-stable'],
    bundleId: 'com.google.chrome',
    desktop: ['google-chrome.desktop', 'chrome.desktop'],
  },
  chromium: {
    name: 'Chromium',
    darwin: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    linux: ['chromium', 'chromium-browser'],
    bundleId: 'org.chromium.chromium',
    desktop: ['chromium.desktop', 'chromium-browser.desktop'],
  },
  edge: {
    name: 'Microsoft Edge',
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
    bundleId: 'com.microsoft.edgemac',
    desktop: ['microsoft-edge.desktop'],
  },
  vivaldi: {
    name: 'Vivaldi',
    darwin: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    linux: ['vivaldi', 'vivaldi-stable'],
    bundleId: 'com.vivaldi.vivaldi',
    desktop: ['vivaldi-stable.desktop', 'vivaldi.desktop'],
  },
};

function resolveBinary(key: string): string | null {
  const spec = BROWSERS[key];
  if (!spec) return null;

  if (platform() === 'darwin') return existsSync(spec.darwin) ? spec.darwin : null;

  for (const candidate of spec.linux) {
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

function installedBrowsers(): string[] {
  return Object.keys(BROWSERS).filter((key) => resolveBinary(key) !== null);
}

/**
 * Which browser the OS opens an https link with, as one of our keys.
 *
 * Returns null both when the lookup fails and when the answer is a browser we
 * cannot drive — Safari and Firefox are not Chromium, and no flag makes their
 * profiles readable by `--cookies-from-browser <path>`. The caller falls back
 * to whatever Chromium-family browser is installed and says so in the UI,
 * because silently opening a different browser than the one someone expects is
 * worse than naming it.
 */
function defaultBrowser(): string | null {
  const handler = platform() === 'darwin' ? macHttpsHandler() : linuxHttpsHandler();
  if (!handler) return null;

  const wanted = handler.toLowerCase();
  return (
    Object.keys(BROWSERS).find(
      (key) =>
        BROWSERS[key].bundleId === wanted ||
        BROWSERS[key].desktop.some((entry) => entry === wanted),
    ) ?? null
  );
}

/**
 * LaunchServices records the https handler in a binary plist, so it is read
 * through plutil rather than parsed. A Mac that has never had the default
 * changed has no entry at all, which reads as "unknown" and is correct.
 */
function macHttpsHandler(): string | null {
  const plist = join(
    homedir(),
    'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
  );
  if (!existsSync(plist)) return null;

  const dumped = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  if (dumped.status !== 0) return null;

  try {
    const parsed = JSON.parse(dumped.stdout) as {
      LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[];
    };
    return (
      parsed.LSHandlers?.find((entry) => entry.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll ??
      null
    );
  } catch {
    return null;
  }
}

function linuxHttpsHandler(): string | null {
  const asked = spawnSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' });
  if (asked.status !== 0) return null;
  return asked.stdout.trim() || null;
}

function haveYtDlp(): boolean {
  return spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' }).status === 0;
}

/**
 * A container has no browser and no display, and never will — the image does
 * not ship one. Saying so by name is what stops the UI offering a button that
 * could only ever fail.
 */
function inContainer(): boolean {
  if (existsSync('/.dockerenv')) return true;
  try {
    return /docker|containerd|kubepods/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/** A Linux box with no X or Wayland session cannot open a window at all. */
function headless(): boolean {
  return platform() === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

export interface CaptureCapability {
  available: boolean;
  /** Our key for the browser that would be launched, e.g. `brave`. */
  browser: string | null;
  /** What a person calls it. */
  browserName: string | null;
  /** False when the OS default is Safari, Firefox, or unknown and we picked one. */
  isDefault: boolean;
  /** Present only when `available` is false: the single reason why. */
  reason: string | null;
}

/**
 * Answering this means shelling out several times — `which`, `plutil`,
 * `yt-dlp --version` — and `/status` is polled while files are in flight. What
 * it measures is installed software and an OS preference, so it is cached for
 * long enough to stop the polling from mattering and short enough that
 * installing a browser is noticed without a restart.
 */
const CAPABILITY_TTL_MS = 60_000;
let cached: { at: number; value: CaptureCapability } | null = null;

export function captureCapability(): CaptureCapability {
  if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value;
  const value = probeCapability();
  cached = { at: Date.now(), value };
  return value;
}

function probeCapability(): CaptureCapability {
  const none = (reason: string): CaptureCapability => ({
    available: false,
    browser: null,
    browserName: null,
    isDefault: false,
    reason,
  });

  if (inContainer()) {
    return none('this API runs in a container, which has no browser and no screen');
  }
  if (headless()) return none('this machine has no graphical session to open a browser in');
  if (!haveYtDlp()) return none('yt-dlp is not installed on the machine running this API');

  const installed = installedBrowsers();
  if (installed.length === 0) {
    return none('no Chromium-family browser (Brave, Chrome, Chromium, Edge, Vivaldi) is installed');
  }

  const preferred = defaultBrowser();
  const browser = preferred && installed.includes(preferred) ? preferred : installed[0];

  return {
    available: true,
    browser,
    browserName: BROWSERS[browser].name,
    isDefault: browser === preferred,
    reason: null,
  };
}

export type CaptureState =
  | 'LAUNCHING'
  | 'WAITING_FOR_LOGIN'
  | 'CAPTURING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED';

export interface CaptureProgress {
  accountId: string;
  state: CaptureState;
  browserName: string;
  /** One sentence describing where this is, safe to render as-is. */
  message: string;
  /** Seconds left before the sign-in wait gives up; null once it is over. */
  secondsLeft: number | null;
  result: { kept: number; dropped: number; domains: string[] } | null;
}

/**
 * Runs the capture and reports where it is.
 *
 * A sign-in takes minutes — a password, a second factor, sometimes a device
 * prompt — which is far too long to hold an HTTP request open through a browser
 * and whatever proxies sit in front of it. So the work runs detached and the UI
 * polls this for a state, the same shape a job queue would give without needing
 * one: nothing here survives a restart, and nothing should.
 */
export class BrowserCapture {
  private readonly log = new Logger(BrowserCapture.name);
  /** One at a time: two browser windows racing for one sign-in helps nobody. */
  private current: CaptureProgress | null = null;
  private cancel: (() => void) | null = null;

  status(accountId: string): CaptureProgress | null {
    return this.current?.accountId === accountId ? this.current : null;
  }

  /** The whole instance's capture, whichever account started it. */
  active(): CaptureProgress | null {
    return this.current && ['LAUNCHING', 'WAITING_FOR_LOGIN', 'CAPTURING'].includes(this.current.state)
      ? this.current
      : null;
  }

  /**
   * Kicks off a capture and returns its first state. `store` is what does
   * something with the jar; keeping it a callback is what keeps this file free
   * of the database and of who owns which account.
   */
  start(
    accountId: string,
    store: (jar: Buffer) => Promise<{ kept: number; dropped: number; domains: string[] }>,
  ): CaptureProgress {
    const running = this.active();
    if (running) {
      throw new Error(
        running.accountId === accountId
          ? 'a capture is already running for this account'
          : 'a capture is already running for another account on this instance',
      );
    }

    const capability = captureCapability();
    if (!capability.available || !capability.browser) {
      throw new Error(capability.reason ?? 'cookie capture is not possible on this machine');
    }

    const progress: CaptureProgress = {
      accountId,
      state: 'LAUNCHING',
      browserName: capability.browserName!,
      message: `Opening ${capability.browserName} with a new, empty profile…`,
      secondsLeft: LOGIN_TIMEOUT_MS / 1000,
      result: null,
    };
    this.current = progress;

    void this.run(capability.browser, progress, store);
    return progress;
  }

  /** Ends the running capture; the browser dies with it. */
  stop(accountId: string): void {
    if (this.current?.accountId === accountId) this.cancel?.();
  }

  private async run(
    browser: string,
    progress: CaptureProgress,
    store: (jar: Buffer) => Promise<{ kept: number; dropped: number; domains: string[] }>,
  ): Promise<void> {
    const binary = resolveBinary(browser)!;
    const profileDir = await mkdtemp(join(tmpdir(), 'yts-profile-'));
    const jarPath = join(profileDir, 'jar.txt');

    let cancelled = false;
    const child = spawn(
      binary,
      [
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        'https://accounts.google.com/ServiceLogin?service=youtube',
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    this.cancel = () => {
      cancelled = true;
      child.kill('SIGKILL');
    };

    try {
      progress.state = 'WAITING_FOR_LOGIN';
      progress.message =
        `Sign in to YouTube in the ${progress.browserName} window that just opened. ` +
        'Leave it open, and do not sign out afterwards — that would end the session server-side.';

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      let signedIn = false;

      while (Date.now() < deadline && !cancelled) {
        await sleep(POLL_MS);
        progress.secondsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));

        if (signedInAt(profileDir)) {
          signedIn = true;
          break;
        }
      }

      if (cancelled) {
        progress.state = 'CANCELLED';
        progress.message = 'Capture cancelled. Nothing was stored.';
        progress.secondsLeft = null;
        return;
      }
      if (!signedIn) throw new Error('timed out waiting for the sign-in to finish');

      progress.state = 'CAPTURING';
      progress.secondsLeft = null;
      progress.message = 'Signed in. Closing the browser so it flushes cookies to disk…';

      // The jar read above came from a live profile mid-write. Chromium only
      // guarantees the file is complete after a clean exit, so the one that
      // gets stored is taken after the window is gone.
      child.kill('SIGTERM');
      await sleep(FLUSH_MS);
      if (!(await extractJar(browser, profileDir, jarPath))) {
        throw new Error('the browser closed before its cookies could be read');
      }

      const jar = await readFile(jarPath);
      if (!hasSessionCookie(jar)) {
        throw new Error(
          'the browser had cookies but no Google session in them - the sign-in may not have finished',
        );
      }

      progress.result = await store(jar);
      progress.state = 'DONE';
      progress.message =
        `Stored ${progress.result.kept} cookies; discarded ${progress.result.dropped} from ` +
        'unrelated domains. The temporary profile has been deleted, so nothing will ever rotate ' +
        'this session behind the app’s back.';
      this.log.log(`captured a cookie jar from a throwaway ${browser} profile`);
    } catch (error) {
      progress.state = 'FAILED';
      progress.secondsLeft = null;
      progress.message = (error as Error).message;
      this.log.warn(`cookie capture failed: ${(error as Error).message}`);
    } finally {
      this.cancel = null;
      child.kill('SIGKILL');
      // The profile holds a live Google session in plaintext-adjacent form.
      // It goes whether this worked or not.
      await rm(profileDir, { recursive: true, force: true });
    }
  }
}

/**
 * Whether a Google session has appeared in the throwaway profile yet.
 *
 * This is asked once a second for up to ten minutes, so it has to be cheap:
 * running yt-dlp instead would spawn a process and hit the network on every
 * poll, which took fourteen seconds a turn here and left a cancel unnoticed for
 * that long.
 *
 * Chromium writes persistent cookies to a SQLite file within seconds of the
 * sign-in. Values in it are encrypted, but *names* are not, so the presence of
 * a session cookie is a byte search over a small file — no sqlite3 binary to
 * depend on and nothing to parse. The write may land in the WAL before the main
 * file, so both are searched.
 */
function signedInAt(profileDir: string): boolean {
  const db = join(profileDir, 'Default', 'Cookies');

  return [db, `${db}-wal`].some((path) => {
    if (!existsSync(path)) return false;
    try {
      const bytes = readFileSync(path);
      return SESSION_COOKIE_NAMES.some((name) => bytes.includes(name));
    } catch {
      // Chromium is writing to it right now; the next poll is a second away.
      return false;
    }
  });
}

/**
 * The two names Google sets on sign-in. The bare `SID` that cookie-jar.ts also
 * accepts is deliberately not here: as a raw byte search it matches inside
 * `SIDCC`, `APISID` and half a dozen others, and a substring is all this has.
 * Both of these are substrings of nothing else.
 */
const SESSION_COOKIE_NAMES = ['__Secure-3PSID', '__Secure-1PSID'];

/**
 * Decrypts the throwaway profile's cookies into `outPath`. False means "not
 * yet" rather than "broken": while nobody has signed in there is no jar to
 * write, which is the normal state for most of the wait.
 */
async function extractJar(browser: string, profileDir: string, outPath: string): Promise<boolean> {
  // Removed first, so a run that fails cannot be mistaken for a run that
  // succeeded by leaving the previous attempt's file behind.
  rmSync(outPath, { force: true });

  // Async, not spawnSync: yt-dlp reaches the network here, and spawnSync would
  // block the event loop for those seconds — with the HTTP server in the same
  // process, that stalls every request including the poll watching this.
  await new Promise<void>((resolve) => {
    const proc = spawn(
      'yt-dlp',
      [
        '--cookies-from-browser', `${browser}:${profileDir}`,
        '--cookies', outPath,
        '--simulate',
        '--no-warnings',
        // yt-dlp insists on a target URL; this one is cheap and never blocks.
        'https://www.youtube.com/robots.txt',
      ],
      { stdio: 'ignore' },
    );
    // yt-dlp exits non-zero on the dummy URL but still writes the jar, so the
    // file's existence is the result and the exit code is not consulted.
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });

  return existsSync(outPath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
