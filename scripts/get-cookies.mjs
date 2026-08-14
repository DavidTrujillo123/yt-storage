#!/usr/bin/env node
/**
 * Captures a YouTube cookie jar without extensions and without touching the
 * profile you browse with.
 *
 * A private window cannot be used for this: its cookies live only in memory and
 * are never written to disk, so nothing can read them. What this does instead
 * gives the same property by different means — it launches the browser against
 * a brand new throwaway profile directory, waits for you to sign in there, and
 * deletes the profile once the cookies are out.
 *
 * That disposability is the whole point. A jar copied from your normal profile
 * dies within minutes: Google rotates session cookies on use, and with the
 * browser still signed in, two clients rotate the same session until it is
 * invalidated. Nothing ever opens this profile again, so its session stays
 * whole.
 *
 * Runs on the machine with the browser, and talks to the API over HTTP — so it
 * works the same whether the API runs natively or in a container.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

const API = process.env.YTS_API ?? 'http://localhost:3000';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** macOS keeps browsers in .app bundles; elsewhere they are on PATH. */
const BROWSERS = {
  brave: {
    darwin: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    linux: ['brave-browser', 'brave', 'brave-browser-stable'],
  },
  chrome: {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: ['google-chrome', 'google-chrome-stable'],
  },
  chromium: {
    darwin: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    linux: ['chromium', 'chromium-browser'],
  },
  edge: {
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    linux: ['microsoft-edge'],
  },
  vivaldi: {
    darwin: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    linux: ['vivaldi'],
  },
};

function resolveBrowser(name) {
  const entry = BROWSERS[name];
  if (!entry) throw new Error(`unsupported browser: ${name}`);

  if (platform() === 'darwin') {
    if (existsSync(entry.darwin)) return entry.darwin;
    throw new Error(`${name} is not installed at ${entry.darwin}`);
  }
  for (const candidate of entry.linux) {
    const found = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (found.status === 0) return found.stdout.trim();
  }
  throw new Error(`${name} was not found on PATH`);
}

function installedBrowsers() {
  return Object.keys(BROWSERS).filter((name) => {
    try {
      resolveBrowser(name);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Chromium writes persistent cookies to this SQLite file within seconds. Only
 * presence is checked — the values are encrypted, and yt-dlp does the
 * decryption later using the OS keyring.
 */
function signedIn(profileDir) {
  const db = join(profileDir, 'Default', 'Cookies');
  if (!existsSync(db)) return false;

  const query = spawnSync(
    'sqlite3',
    [`file:${db}?immutable=1`, "select count(*) from cookies where name in ('__Secure-3PSID','__Secure-1PSID','SID')"],
    { encoding: 'utf8' },
  );
  return query.status === 0 && Number(query.stdout.trim()) > 0;
}

async function waitForLogin(profileDir) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastDots = 0;

  while (Date.now() < deadline) {
    if (signedIn(profileDir)) {
      stdout.write('\n');
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (++lastDots % 5 === 0) stdout.write('.');
  }
  stdout.write('\n');
  return false;
}

function extractJar(browser, profileDir, outPath) {
  // yt-dlp decrypts the profile's cookies; the dummy URL is only there because
  // it insists on a target.
  const run = spawnSync(
    'yt-dlp',
    [
      '--cookies-from-browser', `${browser}:${profileDir}`,
      '--cookies', outPath,
      '--simulate',
      '--no-warnings',
      'https://www.youtube.com/robots.txt',
    ],
    { encoding: 'utf8' },
  );
  if (!existsSync(outPath)) {
    throw new Error(run.stderr?.trim() || 'yt-dlp could not read the temporary profile');
  }
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  const available = installedBrowsers();
  if (available.length === 0) throw new Error('no supported browser found');

  const browser =
    process.argv[2] ??
    (available.length === 1
      ? available[0]
      : await rl.question(`browser (${available.join(', ')}): `));
  const binary = resolveBrowser(browser);

  console.log(`\nSigning in to the API at ${API}`);
  const email = process.env.YTS_EMAIL ?? (await rl.question('email: '));
  const password = process.env.YTS_PASSWORD ?? (await rl.question('password: '));

  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${(await login.json()).message}`);
  const session = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const accounts = await (await fetch(`${API}/accounts`, { headers: { cookie: session } })).json();
  if (accounts.length === 0) throw new Error('no YouTube accounts configured yet');

  let account = accounts[0];
  if (accounts.length > 1) {
    accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.label}`));
    account = accounts[Number(await rl.question('account: ')) - 1];
  }

  const profileDir = await mkdtemp(join(tmpdir(), 'yts-profile-'));
  const jarPath = join(profileDir, 'jar.txt');

  console.log(`
Opening ${browser} with a fresh, empty profile.

  1. Sign in to YouTube with the account behind "${account.label}"
  2. Leave the window open until this says it captured the session
  3. Do NOT sign out - signing out ends the session server-side

Waiting for sign-in`);

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

  try {
    if (!(await waitForLogin(profileDir))) throw new Error('timed out waiting for sign-in');
    console.log('signed in - closing the browser to flush cookies to disk');

    // Chromium only guarantees a cookie flush on a clean exit.
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    extractJar(browser, profileDir, jarPath);

    const form = new FormData();
    form.append('file', new Blob([await readFile(jarPath)]), 'cookies.txt');
    const stored = await fetch(`${API}/accounts/${account.id}/cookies`, {
      method: 'POST',
      headers: { cookie: session },
      body: form,
    });

    const result = await stored.json();
    if (!stored.ok) throw new Error(result.message);

    console.log(`
Stored for "${account.label}": ${result.kept} cookies kept, ${result.dropped} unrelated discarded.
Domains: ${result.domains.join(', ')}

The temporary profile has been deleted, so nothing will ever rotate this
session behind the app's back.`);
  } finally {
    child.kill('SIGKILL');
    await rm(profileDir, { recursive: true, force: true });
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
