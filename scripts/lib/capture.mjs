/**
 * The cookie capture itself, with no opinion about who asked for it.
 *
 * Two callers share this: `get-cookies.mjs`, which runs it once from a terminal,
 * and `cookie-agent.mjs`, which runs it on request from the app's page. Both do
 * the same thing to the same browser, and neither should be the place that
 * knowledge lives.
 *
 * The browser is yours; the profile is not. It is launched against a brand new
 * throwaway `--user-data-dir` and that directory is deleted once the jar is out,
 * so the window carries none of your sessions, history or extensions, and is
 * never opened again. That disposability is the whole point: Google rotates
 * session cookies on use, so a jar copied out of a profile that keeps browsing
 * is rotated by two clients at once and dies within minutes.
 *
 * A private window cannot be used instead, whatever the flags: its cookies live
 * only in memory and never reach disk, so there is nothing for yt-dlp to read.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

export const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube';

export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
/** Chromium only guarantees a cookie flush on a clean exit; this is that wait. */
const FLUSH_MS = 3000;
/**
 * yt-dlp reads a *copy* of the cookie database and does not copy the
 * write-ahead log beside it, so a cookie the browser has written but not yet
 * checkpointed is invisible to it. Hence retries rather than one attempt.
 */
const EXTRACT_TIMEOUT_MS = 30_000;
const EXTRACT_RETRY_MS = 2000;

/**
 * Only Chromium-family browsers can be driven this way: the throwaway profile
 * is a `--user-data-dir`, and yt-dlp reads the jar back out of it. Safari and
 * Firefox have neither, and no flag gives them one.
 *
 * `bundleId` and `desktop` are how macOS and Linux name the same browser when
 * asked which one handles https, which is what makes "the default" resolvable.
 */
export const BROWSERS = {
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

export function resolveBinary(key) {
  const spec = BROWSERS[key];
  if (!spec) return null;

  if (platform() === 'darwin') return existsSync(spec.darwin) ? spec.darwin : null;

  for (const candidate of spec.linux) {
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

export function installedBrowsers() {
  return Object.keys(BROWSERS).filter((key) => resolveBinary(key) !== null);
}

/**
 * Which browser this machine opens an https link with, as one of our keys, or
 * null when that is Safari, Firefox, or nothing recorded at all.
 */
export function defaultBrowser() {
  const handler = platform() === 'darwin' ? macHttpsHandler() : linuxHttpsHandler();
  if (!handler) return null;

  const wanted = handler.toLowerCase();
  return (
    Object.keys(BROWSERS).find(
      (key) =>
        BROWSERS[key].bundleId === wanted || BROWSERS[key].desktop.some((e) => e === wanted),
    ) ?? null
  );
}

/**
 * LaunchServices keeps the https handler in a binary plist, so it is read
 * through plutil rather than parsed. A Mac whose default was never changed has
 * no entry, which reads as "unknown" and is correct.
 */
function macHttpsHandler() {
  const plist = join(
    homedir(),
    'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
  );
  if (!existsSync(plist)) return null;

  const dumped = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  if (dumped.status !== 0) return null;

  try {
    const parsed = JSON.parse(dumped.stdout);
    return (
      parsed.LSHandlers?.find((entry) => entry.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll ??
      null
    );
  } catch {
    return null;
  }
}

function linuxHttpsHandler() {
  const asked = spawnSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' });
  if (asked.status !== 0) return null;
  return asked.stdout.trim() || null;
}

/** The browser a capture would use here: the OS default, or the best stand-in. */
export function pickBrowser(requested) {
  const installed = installedBrowsers();
  if (installed.length === 0) {
    throw new Error('no Chromium-family browser (Brave, Chrome, Chromium, Edge, Vivaldi) found');
  }

  if (requested) {
    if (!installed.includes(requested)) throw new Error(`${requested} is not installed here`);
    return { browser: requested, isDefault: requested === defaultBrowser() };
  }

  const preferred = defaultBrowser();
  const browser = preferred && installed.includes(preferred) ? preferred : installed[0];
  return { browser, isDefault: browser === preferred };
}

export function haveYtDlp() {
  return spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' }).status === 0;
}

/**
 * Where a browser keeps its profiles, or null when it has never been run — a
 * real state and not an error, since there is then no session to take.
 */
export function dataDir(key) {
  const spec = BROWSERS[key];
  if (!spec) return null;

  const roots =
    platform() === 'darwin'
      ? [join(homedir(), 'Library/Application Support', spec.data.darwin)]
      : spec.data.linux.map((path) => join(homedir(), '.config', path));

  return roots.find((path) => existsSync(path)) ?? null;
}

/**
 * Every browser profile on this machine that is already signed in to Google.
 *
 * This is the list the page offers, so it has to be cheap and silent: reading
 * files, never launching anything and never touching the network. In particular
 * it must not decrypt a jar — on macOS that raises a Keychain prompt, and one
 * per profile just to draw a list would be intolerable. The account behind each
 * profile is therefore resolved later, once, for the one that gets picked.
 */
export function listProfiles() {
  const found = [];

  for (const browser of installedBrowsers()) {
    const root = dataDir(browser);
    if (!root) continue;

    const names = describeProfiles(root);
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }

    for (const entry of entries) {
      const profileDir = join(root, entry.name);
      if (!signedInProfile(profileDir)) continue;

      const described = names[entry.name] ?? {};
      found.push({
        // Stable enough to send to the API and back, and readable in a log.
        id: `${browser}:${entry.name}`,
        browser,
        browserName: BROWSERS[browser].name,
        profile: entry.name,
        label: described.name ?? entry.name,
        // YouTube's own auth cookie. A profile can hold a Google session with no
        // YouTube one — Search and Cloud Console are enough to set the rest —
        // and that jar is useless here, so the difference is worth showing
        // before someone picks.
        youtube: hasCookieNamed(profileDir, 'LOGIN_INFO'),
        // Only browsers with a sign-in of their own know this, and Brave
        // disables that by default, so it is usually empty. The jar is what
        // actually answers "which account", after the pick.
        email: described.email ?? null,
        path: profileDir,
      });
    }
  }

  return found;
}

/**
 * The human names the browser itself shows in its profile switcher, read out of
 * `Local State`. Falls back to the directory name, which is what someone with
 * one profile sees anyway ("Default").
 */
function describeProfiles(root) {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'));
    const cache = state?.profile?.info_cache ?? {};
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

/** Whether a profile directory holds a Google session, by the same byte search. */
export function signedInProfile(profileDir) {
  return hasGoogleSession(profileDir);
}

/**
 * Reads the jar out of a profile you already use, without opening anything.
 *
 * The session in it is the one that browser is holding, so it is shared: Google
 * rotates session cookies on use, and a jar taken this way dies as soon as the
 * two copies diverge. That is the trade the caller is making by choosing a live
 * profile over a fresh sign-in, and the UI says so.
 */
export async function captureFromProfile(browser, profileDir) {
  const outDir = await mkdtemp(join(tmpdir(), 'yts-jar-'));
  const jarPath = join(outDir, 'jar.txt');

  try {
    let lastError = '';
    // Two attempts: the browser may be mid-write, and yt-dlp reads a copy of
    // the database without the write-ahead log beside it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = extractJar(browser, profileDir, jarPath);
      if (run.ok) {
        const jar = await readFile(jarPath);
        if (hasSessionCookie(jar.toString('utf8'))) return jar;
        lastError = 'that profile has cookies but no Google session in them';
      } else {
        lastError = run.error || 'yt-dlp could not read that profile';
      }
      await sleep(1500);
    }
    throw new Error(lastError);
  } finally {
    await rm(outDir, { recursive: true, force: true });
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
function cookieHeaderFor(jar, host) {
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

/**
 * Whether a jar is actually signed in to YouTube, and to which account.
 *
 * A profile can hold a perfectly good Google session — Search, Cloud Console,
 * Gemini — and still be signed out of YouTube, which is the only session this
 * app can use. Cookie names alone cannot tell those apart, so the jar is asked
 * to fetch the account page: `"LOGGED_IN":true` in the response is YouTube's own
 * answer, and the address on that page is whose session it is.
 *
 * Failure here is never fatal by itself; the caller decides. A network that is
 * down should not throw away a sign-in someone just did.
 */
export async function identifySession(jar, timeoutMs = 15000) {
  const cookies = cookieHeaderFor(jar, 'www.youtube.com');
  if (!cookies) return { loggedIn: false, account: null, others: [], checked: false };

  const page = await accountPage(cookies, null, timeoutMs);
  if (!page) return { loggedIn: false, account: null, others: [], checked: false };

  const account = emailIn(page);
  return {
    loggedIn: /"LOGGED_IN":\s*true/.test(page),
    account,
    // Everything else signed in behind the same jar, for the page to name. It
    // cannot offer them as choices: see the note on `otherAccounts`.
    others: (await otherAccounts(cookies, timeoutMs)).filter((email) => email !== account),
    checked: true,
  };
}

function emailIn(body) {
  return body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
}

async function accountPage(cookies, authuser, timeoutMs) {
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
async function otherAccounts(cookies, timeoutMs, limit = 6) {
  const found = [];
  for (let index = 0; index < limit; index++) {
    const page = await accountPage(cookies, index, timeoutMs);
    if (!page || !/"LOGGED_IN":\s*true/.test(page)) break;
    const email = emailIn(page);
    if (email && !found.includes(email)) found.push(email);
  }
  return found;
}

/**
 * The two names Google sets on sign-in. The bare `SID` is deliberately absent:
 * as a raw byte search it matches inside `SIDCC`, `APISID` and others, and a
 * substring is all this has. Both of these are substrings of nothing else.
 */
const SESSION_COOKIE_NAMES = ['__Secure-3PSID', '__Secure-1PSID'];

/**
 * Whether a Google session has appeared in the throwaway profile yet.
 *
 * Asked once a second for up to ten minutes, so it has to be cheap. Cookie
 * *values* are encrypted but names are not, so this is a byte search over a
 * small file — no sqlite3 binary to depend on and nothing to parse. A fresh
 * write may live in the WAL before the main file, so both are searched.
 */
export function signedInAt(userDataDir) {
  return hasGoogleSession(join(userDataDir, 'Default'));
}

/**
 * The same question asked of one profile directory rather than a whole
 * user-data-dir: a throwaway has its cookies under `Default`, while the profiles
 * someone actually browses with are `Default`, `Profile 1` and so on beside each
 * other.
 */
function hasGoogleSession(dir) {
  return SESSION_COOKIE_NAMES.some((name) => hasCookieNamed(dir, name));
}

/**
 * Whether a cookie by that name exists in a profile, as a byte search.
 *
 * Values are encrypted; names are not, so this needs no sqlite3 binary and
 * nothing to parse. A fresh write may live in the write-ahead log before the
 * main file, so both are searched.
 */
function hasCookieNamed(dir, name) {
  const db = join(dir, 'Cookies');

  return [db, `${db}-wal`].some((path) => {
    if (!existsSync(path)) return false;
    try {
      return readFileSync(path).includes(name);
    } catch {
      // The browser is writing to it right now; the next poll is a second away.
      return false;
    }
  });
}

/** One yt-dlp run against the throwaway profile. */
function extractJar(browser, profileDir, outPath) {
  // Removed first, so a failed run cannot be mistaken for a successful one by
  // leaving the previous attempt's file behind.
  rmSync(outPath, { force: true });

  const run = spawnSync(
    'yt-dlp',
    [
      '--cookies-from-browser', `${browser}:${profileDir}`,
      '--cookies', outPath,
      '--simulate',
      '--no-warnings',
      // yt-dlp insists on a target URL; this one is cheap and never blocks.
      'https://www.youtube.com/robots.txt',
    ],
    { encoding: 'utf8' },
  );

  // yt-dlp exits non-zero on the dummy URL but still writes the jar, so the
  // file's existence is the result and the exit code is not consulted.
  return existsSync(outPath)
    ? { ok: true }
    : { ok: false, error: (run.stderr ?? '').trim().split('\n').pop() ?? '' };
}

/** A jar is only a jar if a Google session is in it. */
export function hasSessionCookie(text) {
  return /\b(__Secure-3PSID|__Secure-1PSID|\bSID)\b/.test(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens the browser, waits for the sign-in, and hands back the jar.
 *
 * `onState(state, message)` is how a caller follows along — a terminal prints
 * it, the agent turns it into something the page can poll. `cancelled()` is
 * checked between polls, so a cancel takes effect within a second.
 */
export async function runCapture({ browser, onState = () => {}, cancelled = () => false }) {
  const binary = resolveBinary(browser);
  if (!binary) throw new Error(`${browser} is not installed here`);

  const profileDir = await mkdtemp(join(tmpdir(), 'yts-profile-'));
  const jarPath = join(profileDir, 'jar.txt');

  onState('LAUNCHING', `Opening ${BROWSERS[browser].name} with a new, empty profile…`);

  // Launched directly rather than through the OS opener: a distinct
  // --user-data-dir is what makes this a separate window instead of a tab in
  // the browser you are using, and the opener drops flags for a running app.
  const child = spawn(
    binary,
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

  try {
    onState(
      'WAITING_FOR_LOGIN',
      `Sign in to YouTube in the ${BROWSERS[browser].name} window that just opened. Leave it ` +
        'open, and do not sign out afterwards — that would end the session server-side.',
    );

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let signedIn = false;

    while (Date.now() < deadline && !cancelled()) {
      await sleep(POLL_MS);
      if (signedInAt(profileDir)) {
        signedIn = true;
        break;
      }
    }

    if (cancelled()) return null;
    if (!signedIn) throw new Error('timed out waiting for the sign-in to finish');

    onState('CAPTURING', 'Signed in. Closing the browser so it flushes cookies to disk…');

    // The detection above read a profile mid-write. Chromium only guarantees
    // the file is complete after a clean exit, so the jar is taken once the
    // window is gone.
    child.kill('SIGTERM');
    await sleep(FLUSH_MS);

    const extractDeadline = Date.now() + EXTRACT_TIMEOUT_MS;
    let lastError = '';

    while (!cancelled()) {
      const attempt = extractJar(browser, profileDir, jarPath);
      if (attempt.ok) {
        const jar = await readFile(jarPath);
        if (hasSessionCookie(jar.toString('utf8'))) return jar;
        lastError = 'the browser had cookies but no Google session in them';
      } else {
        lastError = attempt.error || 'the browser closed before its cookies could be read';
      }

      if (Date.now() >= extractDeadline) break;
      await sleep(EXTRACT_RETRY_MS);
    }

    if (cancelled()) return null;
    throw new Error(lastError);
  } finally {
    child.kill('SIGKILL');
    // The profile holds a live Google session. It goes whether this worked
    // or not.
    await rm(profileDir, { recursive: true, force: true });
  }
}
