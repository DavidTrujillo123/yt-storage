#!/usr/bin/env node
/**
 * Captures a YouTube cookie jar once, from a terminal, without extensions and
 * without touching the profile you browse with.
 *
 * This is the one-shot form. `cookie-agent.mjs` is the same capture kept
 * running, so the button in the app can ask for it; both share `lib/capture.mjs`
 * and do exactly the same thing to the browser — a brand new throwaway profile,
 * your sign-in, the jar, then the profile deleted.
 *
 * Runs on the machine with the browser and talks to the API over HTTP, so it
 * works the same whether the API runs natively or in a container.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { BROWSERS, haveYtDlp, installedBrowsers, pickBrowser, runCapture } from './lib/capture.mjs';

/**
 * YTS_API is the origin you open in a browser, not the API root. Every route
 * lives under /api — the UI and the API share one port, so the prefix is what
 * separates them — and that prefix is added here rather than being something to
 * remember.
 */
const ORIGIN = (process.env.YTS_API ?? 'http://localhost:3000').replace(/\/+$/, '');
const api = (path) => `${ORIGIN}/api${path}`;

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  if (!haveYtDlp()) throw new Error('yt-dlp is not installed on this machine');

  const available = installedBrowsers();
  if (available.length === 0) throw new Error('no supported browser found');

  // An argument wins, then the OS default; the prompt is only for a machine
  // whose default is Safari or Firefox with several stand-ins installed.
  const asked =
    process.argv[2] ??
    (available.length === 1 ? available[0] : undefined);
  const { browser, isDefault } = pickBrowser(asked);
  const chosen = asked
    ? browser
    : isDefault
      ? browser
      : (await rl.question(`browser (${available.join(', ')}) [${browser}]: `)).trim() || browser;

  console.log(`\nSigning in to the API at ${ORIGIN}`);
  const email = process.env.YTS_EMAIL ?? (await rl.question('email: '));
  const password = process.env.YTS_PASSWORD ?? (await rl.question('password: '));

  const login = await fetch(api('/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${(await login.json()).message}`);
  const session = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const accounts = await (await fetch(api('/accounts'), { headers: { cookie: session } })).json();
  if (accounts.length === 0) throw new Error('no YouTube accounts configured yet');

  // YTS_ACCOUNT is what makes the command the setup page prints a single paste:
  // it already knows which account you are standing on.
  let account;
  if (process.env.YTS_ACCOUNT) {
    account = accounts.find((a) => a.id === process.env.YTS_ACCOUNT);
    if (!account) throw new Error(`no account ${process.env.YTS_ACCOUNT} on this instance`);
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    accounts.forEach((a, i) => console.log(`  ${i + 1}) ${a.label}`));
    account = accounts[Number(await rl.question('account: ')) - 1];
    if (!account) throw new Error('that is not one of the accounts listed');
  }

  console.log(`
Opening ${BROWSERS[chosen].name} with a fresh, empty profile.

  1. Sign in to YouTube with the account behind "${account.label}"
  2. Leave the window open until this says it captured the session
  3. Do NOT sign out - signing out ends the session server-side
`);

  try {
    const jar = await runCapture({
      browser: chosen,
      onState: (_state, message) => console.log(message),
    });

    const form = new FormData();
    form.append('file', new Blob([jar]), 'cookies.txt');
    const stored = await fetch(api(`/accounts/${account.id}/cookies`), {
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
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
