'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type {
  Account,
  Bootstrap,
  CaptureProgress,
  CaptureState,
  CookieCapture,
  Status,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';

/** useSearchParams needs a boundary; the OAuth callback returns with ?connected=1. */
export default function SetupPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Setup />
    </Suspense>
  );
}

/**
 * The path from a bare instance to one that can store a file.
 *
 * Every step's state is read back from `/status` and `/auth/bootstrap` rather
 * than tracked here, so the wizard has nothing of its own to lose: reloading,
 * or coming back from Google's consent screen, lands exactly where the instance
 * actually is.
 */
function Setup() {
  const session = useSession();
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, info] = await Promise.all([
        api<Status>('/status'),
        api<Bootstrap>('/auth/bootstrap'),
      ]);
      setStatus(next);
      setBootstrap(info);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 401)) setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    if (session) void refresh();
  }, [session, refresh]);

  // Read after mount, never during render: this page is prerendered at build
  // time, and reading `location` in the render pass makes the server and client
  // markup disagree.
  const origin = useOrigin();

  if (!session || !status || !bootstrap) return <p className="muted">Checking this instance…</p>;

  const account = status.accounts[0] ?? null;
  const secured = !bootstrap.defaultAdmin;
  const created = account !== null;
  const connected = account?.connected === true;
  const cookied = account?.hasCookies === true && account.cookieHealth === 'OK';
  const done = secured && created && connected && cookied;

  return (
    <>
      <h1>Setup</h1>
      <p className="lede">
        Four things stand between a fresh instance and its first stored file. This page reads the
        real state of each one, so you can leave and come back.
      </p>

      {params.get('connected') === '1' && (
        <div className="notice">Google authorisation completed.</div>
      )}
      <RedirectMismatch origin={origin} redirectUri={status.redirectUri} />
      {error && <p className="error">{error}</p>}

      <div className="stack">
        <Step n={1} title="Secure this instance" done={secured} current={!secured}>
          <SecurePassword
            email={bootstrap.defaultAdmin ?? ''}
            minLength={bootstrap.minPasswordLength}
            onDone={refresh}
            onError={setError}
          />
        </Step>

        <Step n={2} title="Add a YouTube account" done={created} current={secured && !created}>
          <CreateAccount
            origin={origin}
            redirectUri={status.redirectUri}
            onDone={refresh}
            onError={setError}
          />
        </Step>

        <Step
          n={3}
          title="Authorise with Google"
          done={connected}
          current={created && !connected}
          summary={account ? `${account.label} is connected` : undefined}
        >
          <p className="small muted">
            This is the round trip that returns a refresh token, which is what lets the app upload
            without you present. If Google sends you back without one, revoke the app at
            <span className="mono"> myaccount.google.com/permissions</span> and try again.
          </p>
          {account && (
            <a className="button" href={`/api/accounts/${account.id}/connect?return=setup`}>
              Authorise {account.label}
            </a>
          )}
        </Step>

        <Step
          n={4}
          title="Give it cookies"
          done={cookied}
          current={connected && !cookied}
          summary={account ? `cookie jar stored and healthy` : undefined}
        >
          {account && (
            <Cookies
              account={account}
              origin={origin}
              capture={status.cookieCapture}
              onDone={refresh}
              onError={setError}
            />
          )}
        </Step>
      </div>

      {done && (
        <section className="panel" style={{ marginTop: '1.25rem' }}>
          <h2>Ready</h2>
          <p className="small muted">
            {status.uploadsLeftToday} upload{status.uploadsLeftToday === 1 ? '' : 's'} left today —
            the allowance is 100 a day per Cloud project, and an upload counts as one regardless
            of file size.
          </p>
          <Link className="button" href="/files">
            Go to Files
          </Link>
        </section>
      )}
    </>
  );
}

/**
 * The one misconfiguration that cannot be discovered by trying.
 *
 * `GOOGLE_REDIRECT_URI` is where the server tells Google to send the browser
 * back. If it names an address this instance is not reached at — the default
 * localhost while you are on a LAN IP or a Tailscale name, a port that only
 * matches inside the container — step 3 fails with `redirect_uri_mismatch`
 * after the consent screen, which looks like a problem with the Cloud project
 * rather than with this server's environment.
 */
function RedirectMismatch({ origin, redirectUri }: { origin: string; redirectUri: string }) {
  if (!origin) return null;

  let configured: string;
  try {
    configured = new URL(redirectUri).origin;
  } catch {
    return (
      <div className="notice" style={{ borderLeftColor: 'var(--bad)' }}>
        <strong>GOOGLE_REDIRECT_URI is not a valid URL</strong> (<span className="mono">{redirectUri}</span>).
        Authorising an account will fail until it is set to{' '}
        <span className="mono">{origin}/accounts/callback</span>.
      </div>
    );
  }

  if (configured === origin) return null;

  return (
    <div className="notice" style={{ borderLeftColor: 'var(--bad)' }}>
      <strong>This server expects to be reached at a different address.</strong> You are on{' '}
      <span className="mono">{origin}</span>, but <span className="mono">GOOGLE_REDIRECT_URI</span>{' '}
      is <span className="mono">{redirectUri}</span>. Google sends the browser back to the second
      one, so step 3 will fail with <span className="mono">redirect_uri_mismatch</span>.
      <div style={{ marginTop: '0.4rem' }}>
        Set it to <span className="mono">{origin}/accounts/callback</span> in the environment,
        restart, and register that same value in the Google Cloud project. All three have to agree.
      </div>
    </div>
  );
}

/** A step shows its body while it is the one to do, and a single line once it is not. */
function Step({
  n,
  title,
  done,
  current,
  summary,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  current: boolean;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel" style={{ opacity: done || current ? 1 : 0.55 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {n}. {title}
        </h2>
        <span className="badge" data-tone={done ? 'ok' : current ? 'busy' : undefined}>
          {done ? 'done' : current ? 'do this now' : 'waiting'}
        </span>
      </div>
      {done ? (
        summary && <p className="small muted">{summary}</p>
      ) : current ? (
        <div style={{ marginTop: '0.75rem' }}>{children}</div>
      ) : (
        <p className="small muted">Finish the step above first.</p>
      )}
    </section>
  );
}

function SecurePassword({
  email,
  minLength,
  onDone,
  onError,
}: {
  email: string;
  minLength: number;
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      await onDone();
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="small muted">
        <span className="mono">{email}</span> is still on the password this app ships with, which is
        printed in its README. This instance will hold cookie jars that authenticate every Google
        service on that account — not just YouTube — so anyone who reaches this page and has not
        been stopped here owns those accounts.
      </p>
      <form onSubmit={submit} style={{ maxWidth: '24rem' }}>
        <div className="field">
          <label htmlFor="currentPassword">Current password</label>
          <input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="newPassword">New password</label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={minLength}
            required
          />
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
      <p className="small muted">
        Every other session is signed out when you do this. There is no reset flow, so keep the new
        one somewhere you will find it.
      </p>
    </>
  );
}

function CreateAccount({
  origin,
  redirectUri,
  onDone,
  onError,
}: {
  origin: string;
  redirectUri: string;
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/accounts', { method: 'POST', body: JSON.stringify({ label, clientId, clientSecret }) });
      await onDone();
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="small muted">
        An account is one Google Cloud project plus one YouTube channel. Quota is charged per
        project, so a second channel only adds capacity if it brings its own project.
      </p>
      <ol className="small muted" style={{ paddingLeft: '1.1rem' }}>
        <li>Create a project at console.cloud.google.com and enable YouTube Data API v3.</li>
        <li>
          Create an OAuth client of type <strong>Web application</strong> with this redirect URI,
          copied exactly — it is what the server will actually send Google:
          <Copyable text={redirectUri} />
          It sits outside <span className="mono">/api</span> deliberately, and changing it later
          breaks every account already connected.
        </li>
        <li>
          Set the publishing status to <strong>In production</strong>, not Testing. In Testing,
          Google expires refresh tokens after 7 days and the account dies every week. Unverified
          production is fine — click through the warning.
        </li>
      </ol>
      <form onSubmit={submit} style={{ maxWidth: '28rem' }}>
        <div className="field">
          <label htmlFor="label">Label</label>
          <input id="label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="clientId">OAuth client id</label>
          <input id="clientId" type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="clientSecret">OAuth client secret</label>
          <input
            id="clientSecret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            required
          />
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add account'}
        </button>
      </form>
    </>
  );
}

function Cookies({
  account,
  origin,
  capture,
  onDone,
  onError,
}: {
  account: Account;
  origin: string;
  capture: CookieCapture;
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function upload(file: File) {
    const body = new FormData();
    body.append('file', file);
    try {
      const stored = await api<{ kept: number; dropped: number }>(
        `/accounts/${account.id}/cookies`,
        { method: 'POST', body },
      );
      setResult(`kept ${stored.kept} cookies, discarded ${stored.dropped} from unrelated domains`);
      await onDone();
    } catch (failure) {
      onError((failure as Error).message);
    }
  }

  return (
    <>
      <p className="small muted">
        The OAuth token uploads, but it cannot download: every video this app creates is private,
        and a private video is only served to a signed-in browser session. That session is the
        cookie jar.
      </p>

      {capture.available ? (
        <CaptureButton account={account} capture={capture} onDone={onDone} onError={onError} />
      ) : (
        <>
          <h3 style={{ marginBottom: '0.35rem' }}>Run this on the machine with your browser</h3>
          <p className="small muted">
            This server cannot open a browser itself — {capture.reason} — so the capture runs where
            you are instead. It talks back to this instance over HTTP.
          </p>
          <Copyable text={`YTS_API=${origin} YTS_ACCOUNT=${account.id} pnpm run cookies`} />
          <p className="small muted">
            It opens a brand new, throwaway browser profile, waits for you to sign in to YouTube,
            takes the jar and deletes the profile. Nothing ever opens that profile again, which is
            the point — Google rotates session cookies on use, and a jar shared with a browser you
            keep using is invalidated within minutes.
          </p>
        </>
      )}

      <h3 style={{ marginBottom: '0.35rem' }}>Or upload a cookies.txt</h3>
      <p className="small muted">
        Export it in Netscape format from a private window, then close that window <em>without</em>{' '}
        signing out — signing out ends the session server-side and the exported jar with it.
      </p>
      <div className="row">
        <button onClick={() => input.current?.click()}>Upload cookies.txt</button>
        <input
          ref={input}
          type="file"
          accept=".txt"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = '';
          }}
        />
        {result && <span className="small muted">{result}</span>}
      </div>

      <p className="small" style={{ color: 'var(--warn)' }}>
        A jar authenticates every Google service on that account, not just YouTube. Use a throwaway
        account that is not the recovery address for anything else.
      </p>
    </>
  );
}

/** States where the server still has a browser open and something to report. */
const RUNNING: CaptureState[] = ['LAUNCHING', 'WAITING_FOR_LOGIN', 'CAPTURING'];

/**
 * The last step as one button: the server opens a browser, you sign in, it
 * takes the jar.
 *
 * A sign-in runs for minutes, so the request that starts it returns at once and
 * this polls for where it got to. Everything shown comes from the server's
 * state rather than from anything tracked here, so reloading mid-capture picks
 * the same capture back up.
 *
 * It is *not* a private window, and cannot be: private-window cookies live only
 * in RAM and are never written anywhere readable. A new throwaway profile,
 * deleted afterwards, is what gives the same guarantee — the session it holds
 * is never opened again, so nothing rotates it out from under this app.
 */
function CaptureButton({
  account,
  capture,
  onDone,
  onError,
}: {
  account: Account;
  capture: CookieCapture;
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const running = progress !== null && RUNNING.includes(progress.state);

  // A capture that outlived this page — a reload, a second tab — is adopted on
  // mount rather than competing with a new one.
  useEffect(() => {
    void api<CaptureProgress>(`/accounts/${account.id}/cookies/capture`)
      .then((current) => {
        if (current.state !== 'IDLE') setProgress(current);
      })
      .catch(() => undefined);
  }, [account.id]);

  useEffect(() => {
    if (!running) return;

    let live = true;
    const timer = setInterval(async () => {
      try {
        const next = await api<CaptureProgress>(`/accounts/${account.id}/cookies/capture`);
        if (!live) return;
        setProgress(next);
        // `refresh` is what flips the step to done; only worth a round trip
        // once there is something new for it to read.
        if (next.state === 'DONE') await onDone();
      } catch (failure) {
        if (live) onError((failure as Error).message);
      }
    }, 2000);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, account.id, onDone, onError]);

  async function start() {
    setStarting(true);
    try {
      setProgress(await api<CaptureProgress>(`/accounts/${account.id}/cookies/capture`, { method: 'POST' }));
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    try {
      await api(`/accounts/${account.id}/cookies/capture`, { method: 'DELETE' });
    } catch (failure) {
      onError((failure as Error).message);
    }
  }

  return (
    <>
      <h3 style={{ marginBottom: '0.35rem' }}>Sign in and let this take the jar</h3>
      <p className="small muted">
        Opens {capture.browserName} on the machine running this server, with a brand new, empty
        profile. Sign in to the account behind <strong>{account.label}</strong>, and the profile is
        deleted the moment its cookies are out — nothing ever opens it again, which is the point.
        Google rotates session cookies on use, so a jar shared with a browser you keep using is
        invalidated within minutes.
        {!capture.isDefault && (
          <>
            {' '}
            Your default browser cannot be driven this way — only Chromium-family ones can — so{' '}
            {capture.browserName} is used instead.
          </>
        )}
      </p>

      <div className="row">
        <button className="primary" onClick={() => void start()} disabled={starting || running}>
          {running ? 'Waiting…' : starting ? 'Starting…' : `Open ${capture.browserName} and sign in`}
        </button>
        {running && <button onClick={() => void cancel()}>Cancel</button>}
      </div>

      {progress && progress.state !== 'IDLE' && (
        <p
          className="small"
          style={{
            color:
              progress.state === 'FAILED'
                ? 'var(--bad)'
                : progress.state === 'DONE'
                  ? 'var(--ok)'
                  : undefined,
          }}
        >
          {progress.message}
          {progress.state === 'WAITING_FOR_LOGIN' && typeof progress.secondsLeft === 'number' && (
            <span className="muted"> ({Math.ceil(progress.secondsLeft / 60)} min left)</span>
          )}
        </p>
      )}

      <p className="small muted">
        Do not sign out in that window afterwards. Signing out ends the session on Google&apos;s
        side, and the jar with it.
      </p>
    </>
  );
}

/**
 * The address this instance is being used at, which is what belongs in a
 * redirect URI and in a command someone runs elsewhere. Empty until mounted so
 * the prerendered markup and the first client render agree.
 */
function useOrigin(): string {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

/** A command is only useful here if it can be taken in one click. */
function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="row" style={{ margin: '0.4rem 0 0.6rem' }}>
      <code className="mono" style={{ wordBreak: 'break-all' }}>
        {text}
      </code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
