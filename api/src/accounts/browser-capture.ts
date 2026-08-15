/**
 * Captures a YouTube cookie jar by opening the machine's default browser, so
 * the setup wizard can finish with a button instead of a command someone has to
 * paste into a terminal.
 *
 * The browser is yours; the profile is not. It is launched against a brand new
 * throwaway `--user-data-dir` and that directory is deleted once the jar is out,
 * which is what makes the window a sign-in and nothing else — your own sessions,
 * history and extensions are not in it and are never read.
 *
 * The disposability is the whole point rather than a tidy-up. Google rotates
 * session cookies on use, so a jar copied out of a profile that stays signed in
 * is rotated by two clients at once and dies within minutes. Nothing ever opens
 * this profile again, so its session stays whole.
 *
 * A private window cannot be used for this, and no amount of flags changes it:
 * its cookies live only in memory and are never written to disk, so there is
 * nothing for yt-dlp to read. The throwaway profile is the same guarantee by
 * other means.
 *
 * This only works when the API process shares a machine — and a graphical
 * session — with the browser, which a container never does: it cannot exec on
 * the host, and on macOS it is a Linux VM that cannot see /Applications or the
 * Keychain key that decrypts the cookies. `captureCapability()` is what the UI
 * asks before offering any of this, and when it says no the answer is the paste
 * in `cookie-jar.ts` — the `cookie:` header out of DevTools, which needs no
 * browser here and nothing installed there.
 */
import { Logger } from '@nestjs/common';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasSessionCookie } from './cookie-jar';

/** Where the browser lands. */
const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube';

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
 * A clean exit checkpoints the write-ahead log, but the browser takes its own
 * time about it and yt-dlp reads a copy of the database without that log beside
 * it. So extraction is retried rather than attempted once — this is the window
 * it gets before the failure is real.
 */
const EXTRACT_TIMEOUT_MS = 30_000;
const EXTRACT_RETRY_MS = 2000;

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
  /** Where its profiles live, under ~/Library/Application Support or ~/.config. */
  data: { darwin: string; linux: string[] };
}

const BROWSERS: Record<string, BrowserSpec> = {
  brave: {
    name: 'Brave',
    darwin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    linux: ['brave-browser', 'brave', 'brave-browser-stable'],
    bundleId: 'com.brave.browser',
    desktop: ['brave-browser.desktop', 'brave.desktop', 'brave_brave.desktop'],
    data: { darwin: 'BraveSoftware/Brave-Browser', linux: ['BraveSoftware/Brave-Browser'] },
  },
  chrome: {
    name: 'Google Chrome',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: ['google-chrome', 'google-chrome-stable'],
    bundleId: 'com.google.chrome',
    desktop: ['google-chrome.desktop', 'chrome.desktop'],
    data: { darwin: 'Google/Chrome', linux: ['google-chrome'] },
  },
  chromium: {
    name: 'Chromium',
    darwin: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    linux: ['chromium', 'chromium-browser'],
    bundleId: 'org.chromium.chromium',
    desktop: ['chromium.desktop', 'chromium-browser.desktop'],
    data: { darwin: 'Chromium', linux: ['chromium', 'chromium-browser'] },
  },
  edge: {
    name: 'Microsoft Edge',
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
    bundleId: 'com.microsoft.edgemac',
    desktop: ['microsoft-edge.desktop'],
    data: { darwin: 'Microsoft Edge', linux: ['microsoft-edge'] },
  },
  vivaldi: {
    name: 'Vivaldi',
    darwin: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    linux: ['vivaldi', 'vivaldi-stable'],
    bundleId: 'com.vivaldi.vivaldi',
    desktop: ['vivaldi-stable.desktop', 'vivaldi.desktop'],
    data: { darwin: 'Vivaldi', linux: ['vivaldi'] },
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

/** One of this machine's browser profiles, as the picker shows it. */
export interface BrowserProfile {
  /** `brave:Default`; stable enough to send to the page and back. */
  id: string;
  browser: string;
  browserName: string;
  profile: string;
  /** What the browser's own profile switcher calls it. */
  label: string;
  /** Only browsers with a sign-in of their own know this; usually null. */
  email: string | null;
  /**
   * Whether YouTube's own auth cookie is in there. A profile can hold a Google
   * session with no YouTube one — Search and Cloud Console are enough to set the
   * rest — and that jar is useless here, so the difference is shown before
   * anyone picks.
   */
  youtube: boolean;
}

/**
 * Where a browser keeps its profiles, or null when it has never been run — a
 * real state and not an error, since there is then no session to take.
 */
function dataDir(key: string): string | null {
  const spec = BROWSERS[key];
  if (!spec) return null;

  const roots =
    platform() === 'darwin'
      ? [join(homedir(), 'Library/Application Support', spec.data.darwin)]
      : spec.data.linux.map((path) => join(homedir(), '.config', path));

  return roots.find((path) => existsSync(path)) ?? null;
}

/**
 * Every profile on this machine that is already signed in to Google.
 *
 * Deliberately cheap and silent: it reads files, launches nothing and touches
 * no network. In particular it never decrypts a jar — on macOS that raises a
 * Keychain prompt, and one per profile just to draw a list would be
 * intolerable. Which account a profile belongs to is answered later, once, for
 * the one that gets picked.
 */
export function listProfiles(): BrowserProfile[] {
  const found: BrowserProfile[] = [];

  for (const browser of installedBrowsers()) {
    const root = dataDir(browser);
    if (!root) continue;

    const named = describeProfiles(root);
    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const profile of entries) {
      if (!hasGoogleSession(join(root, profile))) continue;
      found.push({
        id: `${browser}:${profile}`,
        browser,
        browserName: BROWSERS[browser].name,
        profile,
        label: named[profile]?.name ?? profile,
        email: named[profile]?.email ?? null,
        youtube: hasCookieNamed(join(root, profile), 'LOGIN_INFO'),
      });
    }
  }

  return found;
}

/** The absolute path behind an id like `brave:Default`, if it still exists. */
function profilePath(id: string): { browser: string; path: string; label: string } | null {
  const entry = listProfiles().find((candidate) => candidate.id === id);
  if (!entry) return null;

  const root = dataDir(entry.browser);
  return root ? { browser: entry.browser, path: join(root, entry.profile), label: entry.label } : null;
}

/**
 * The human names the browser shows in its own profile switcher, out of
 * `Local State`. Falls back to the directory name, which is what someone with a
 * single profile sees anyway ("Default").
 */
function describeProfiles(root: string): Record<string, { name: string; email: string | null }> {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> };
    };
    const cache = state.profile?.info_cache ?? {};
    return Object.fromEntries(
      Object.entries(cache).map(([dir, info]) => [
        dir,
        { name: info?.name || dir, email: info?.user_name || null },
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * A container has no browser and no screen, and cannot reach the one on your
 * desk: it cannot launch it, and on macOS it could not decrypt its cookies
 * either, since that key lives in the Keychain. Saying so by name is what points
 * the UI at the local agent instead of offering a button that could only fail.
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

  if (!haveYtDlp()) return none('yt-dlp is not installed on the machine running this API');

  if (inContainer()) {
    return none(
      'this API runs in a container, which cannot open or read the browser on your machine',
    );
  }
  if (headless()) return none('this machine has no graphical session to open a browser in');

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
  /** The Google account the jar turned out to hold, once that is known. */
  account: string | null;
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
      account: null,
      result: null,
    };
    this.current = progress;

    void this.run(capability.browser, progress, store);
    return progress;
  }

  /**
   * Takes the jar out of a profile this machine already has signed in, which is
   * what the picker asks for: no window opens and nothing is typed.
   *
   * The session it copies is the one that profile is holding, so the two share
   * it — and Google rotates session cookies on use, which is why the jar can die
   * while the browser keeps browsing. That trade is the caller's to make, and
   * the UI states it beside the list.
   */
  startFromProfile(
    accountId: string,
    profileId: string,
    store: (jar: Buffer) => Promise<{ kept: number; dropped: number; domains: string[] }>,
  ): CaptureProgress {
    const running = this.active();
    if (running) throw new Error('a capture is already running on this instance');

    if (!haveYtDlp()) throw new Error('yt-dlp is not installed on the machine running this API');
    const chosen = profilePath(profileId);
    if (!chosen) throw new Error(`no browser profile ${profileId} on this machine`);

    const progress: CaptureProgress = {
      accountId,
      state: 'CAPTURING',
        browserName: BROWSERS[chosen.browser].name,
      message:
        `Reading the cookies out of ${BROWSERS[chosen.browser].name} — ${chosen.label}…` +
        (platform() === 'darwin'
          ? ' macOS will ask for your login password to unlock its Safe Storage key.'
          : ''),
      secondsLeft: null,
      account: null,
      result: null,
    };
    this.current = progress;

    void this.runProfile(chosen, progress, store);
    return progress;
  }

  /** Ends the running capture; the throwaway browser window dies with it. */
  stop(accountId: string): void {
    if (this.current?.accountId === accountId) this.cancel?.();
  }

  /**
   * The picker's capture: one yt-dlp run against a profile that is already
   * signed in. No window to open, so no sign-in wait and nothing to close.
   */
  private async runProfile(
    chosen: { browser: string; path: string; label: string },
    progress: CaptureProgress,
    store: (jar: Buffer) => Promise<{ kept: number; dropped: number; domains: string[] }>,
  ): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), 'yts-jar-'));
    let cancelled = false;
    this.cancel = () => {
      cancelled = true;
    };

    try {
      const jar = await pullJar(chosen.browser, chosen.path, join(workDir, 'jar.txt'), () => cancelled);
      if (cancelled) {
        progress.state = 'CANCELLED';
        progress.message = 'Capture cancelled. Nothing was stored.';
        return;
      }

      // Asked before storing: a profile can hold a Google session and still be
      // signed out of YouTube, and that jar authenticates nothing here.
      const session = await identifySession(jar);
      if (session.checked && !session.loggedIn) {
        throw new Error(
          `${progress.browserName} — ${chosen.label} has Google cookies but is not signed in to ` +
            'YouTube. Open youtube.com in that profile, sign in, and pick it again.',
        );
      }

      progress.account = session.account;
      progress.result = await store(jar);
      progress.state = 'DONE';
      progress.message =
        `Stored ${progress.result.kept} cookies from ${progress.browserName} — ${chosen.label}` +
        (session.account ? `, signed in as ${session.account}` : '') +
        `; discarded ${progress.result.dropped} from unrelated domains.` +
        (session.others.length
          ? ` That profile also holds ${session.others.join(', ')}, but a jar can only ever be its ` +
            'effective account — sign one of those in to a browser profile of its own to use it.'
          : '') +
        ' This jar shares its session with that profile, so keep browsing YouTube there and Google ' +
        'may rotate it away.';
      this.log.log(`captured a cookie jar from the live ${chosen.browser} profile ${chosen.label}`);
    } catch (error) {
      progress.state = 'FAILED';
      progress.message = (error as Error).message;
      this.log.warn(`cookie capture failed: ${(error as Error).message}`);
    } finally {
      this.cancel = null;
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async run(
    browser: string,
    progress: CaptureProgress,
    store: (jar: Buffer) => Promise<{ kept: number; dropped: number; domains: string[] }>,
  ): Promise<void> {
    const profileDir = await mkdtemp(join(tmpdir(), 'yts-profile-'));
    const jarPath = join(profileDir, 'jar.txt');

    let cancelled = false;
    // Launched directly, not through the OS opener: a distinct --user-data-dir
    // is what makes this a second instance rather than a tab in the one you are
    // using, and LaunchServices drops the flags when the app is already running.
    const child: ChildProcess = spawn(
        resolveBinary(browser)!,
        [
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--new-window',
          SIGN_IN_URL,
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

      // The detection above read a live profile mid-write. Chromium only
      // guarantees the file is complete after a clean exit, so the jar that
      // gets stored is taken once the window is gone.
      child.kill('SIGTERM');
      await sleep(FLUSH_MS);

      const jar = await pullJar(browser, profileDir, jarPath, () => cancelled);
      if (cancelled) {
        progress.state = 'CANCELLED';
        progress.message = 'Capture cancelled. Nothing was stored.';
        return;
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
      // A window left open would keep rotating the session just stored.
      child.kill('SIGKILL');
      // The profile holds a live Google session in plaintext-adjacent form.
      // It goes whether this worked or not.
      await rm(profileDir, { recursive: true, force: true });
    }
  }
}

/**
 * A cookie header for one host, out of a Netscape jar.
 *
 * Per host, and never the whole jar at once: `SID` exists for `.google.com` and
 * for `.youtube.com` with *different* values, so a header carrying both is a set
 * Google rejects outright — it answers `accounts.google.com/CookieMismatch` and
 * every check built on it reads as "signed out". That mistake cost an hour here.
 */
function cookieHeaderFor(jar: Buffer, host: string): string {
  return jar
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => (line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line))
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 7)
    .filter(([domain]) =>
      domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain,
    )
    .map((parts) => `${parts[5]}=${parts[6]}`)
    .join('; ');
}

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36';

export interface SessionIdentity {
  loggedIn: boolean;
  account: string | null;
  /** Other accounts signed in behind the same jar; informational only. */
  others: string[];
  /** False when the question could not be asked at all, which is not an answer. */
  checked: boolean;
}

/**
 * Whether a jar is actually signed in to YouTube, and to which account.
 *
 * A profile can hold a perfectly good Google session — Search, Cloud Console,
 * Gemini — and still be signed out of YouTube, which is the only session this
 * app can use. Cookie names cannot tell those apart, so the jar is made to fetch
 * the account page: `"LOGGED_IN":true` is YouTube's own answer, and the address
 * on that page is whose session it is.
 *
 * A failure here is not by itself fatal, and the caller decides: a network that
 * is down should not throw away a sign-in someone just did.
 */
export async function identifySession(jar: Buffer, timeoutMs = 15_000): Promise<SessionIdentity> {
  const cookies = cookieHeaderFor(jar, 'www.youtube.com');
  const nothing = { loggedIn: false, account: null, others: [], checked: false };
  if (!cookies) return nothing;

  const page = await accountPage(cookies, null, timeoutMs);
  if (!page) return nothing;

  const account = emailIn(page);
  return {
    loggedIn: /"LOGGED_IN":\s*true/.test(page),
    account,
    others: (await otherAccounts(cookies, timeoutMs)).filter((email) => email !== account),
    checked: true,
  };
}

function emailIn(body: string): string | null {
  return body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
}

async function accountPage(
  cookies: string,
  authuser: number | null,
  timeoutMs: number,
): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const url =
      authuser === null
        ? 'https://www.youtube.com/account'
        : `https://www.youtube.com/account?authuser=${authuser}`;
    const response = await fetch(url, {
      headers: { cookie: cookies, 'user-agent': DESKTOP_UA },
      signal: abort.signal,
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The other Google accounts signed in behind the same cookies.
 *
 * One profile can hold several — `?authuser=N` walks them — and someone with
 * four of them deserves to be told which four rather than guessing. They are
 * *not* offered as a choice, because nothing downstream could honour it: yt-dlp
 * has no account switch, and `X-Goog-AuthUser` was measured here to change
 * nothing. A jar authenticates as the profile's effective account and no other.
 * To use one of the rest, sign into it in a browser profile of its own — the
 * picker then lists that profile separately.
 */
async function otherAccounts(cookies: string, timeoutMs: number, limit = 6): Promise<string[]> {
  const found: string[] = [];
  for (let index = 0; index < limit; index++) {
    const page = await accountPage(cookies, index, timeoutMs);
    if (!page || !/"LOGGED_IN":\s*true/.test(page)) break;
    const email = emailIn(page);
    if (email && !found.includes(email)) found.push(email);
  }
  return found;
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
function signedInAt(userDataDir: string): boolean {
  return hasGoogleSession(join(userDataDir, 'Default'));
}

/**
 * The same question asked of one profile directory rather than a whole
 * user-data-dir: a throwaway keeps its cookies under `Default`, while the
 * profiles someone actually browses with sit beside each other.
 */
function hasGoogleSession(dir: string): boolean {
  return SESSION_COOKIE_NAMES.some((name) => hasCookieNamed(dir, name));
}

/**
 * Whether a cookie by that name exists in a profile, as a byte search.
 *
 * Values are encrypted; names are not, so this needs no sqlite3 binary and
 * nothing to parse. A fresh write may land in the write-ahead log before the
 * main file, so both are searched.
 */
function hasCookieNamed(dir: string, name: string): boolean {
  const db = join(dir, 'Cookies');

  return [db, `${db}-wal`].some((path) => {
    if (!existsSync(path)) return false;
    try {
      return readFileSync(path).includes(name);
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
 * Extracts the jar, retrying until it actually contains a session.
 *
 * One attempt is nearly always enough after a clean exit, and "nearly" is why
 * this loops: yt-dlp reads a *copy* of the cookie database without the
 * write-ahead log beside it, so a cookie Chromium has written but not yet
 * checkpointed is invisible to it — which is exactly the cookie just detected in
 * that log. Retrying costs seconds; failing here costs the whole sign-in.
 */
async function pullJar(
  browser: string,
  profileDir: string,
  outPath: string,
  cancelled: () => boolean,
): Promise<Buffer> {
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS;
  let lastError = '';

  while (!cancelled()) {
    const attempt = await extractJar(browser, profileDir, outPath);
    if (attempt.ok) {
      const jar = await readFile(outPath);
      if (hasSessionCookie(jar)) return jar;
      lastError =
        'the browser had cookies but no Google session in them - the sign-in may not have finished';
    } else {
      lastError = attempt.error || 'the browser closed before its cookies could be read';
    }

    if (Date.now() >= deadline) break;
    await sleep(EXTRACT_RETRY_MS);
  }

  if (cancelled()) return Buffer.alloc(0);
  throw new Error(lastError);
}

/** One yt-dlp run against the throwaway profile. */
async function extractJar(
  browser: string,
  profileDir: string,
  outPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Removed first, so a run that fails cannot be mistaken for a run that
  // succeeded by leaving the previous attempt's file behind.
  rmSync(outPath, { force: true });

  // Async, not spawnSync: yt-dlp reaches the network here, and spawnSync would
  // block the event loop for those seconds — with the HTTP server in the same
  // process, that stalls every request including the poll watching this.
  const stderr = await new Promise<string>((resolve) => {
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
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let text = '';
    proc.stderr.on('data', (chunk: Buffer) => (text += chunk.toString()));
    // yt-dlp exits non-zero on the dummy URL but still writes the jar, so the
    // file's existence is the result and the exit code is not consulted.
    proc.on('close', () => resolve(text));
    proc.on('error', (error) => resolve(error.message));
  });

  return existsSync(outPath)
    ? { ok: true }
    : { ok: false, error: stderr.trim().split('\n').pop() ?? '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
