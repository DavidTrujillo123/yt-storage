'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError, formatWhen } from '@/lib/api';
import type { Account, CookieCapture, Status } from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { openSignInWindow, useCookieCapture } from '@/lib/use-capture';
import { ReopenSignIn } from '@/app/remote-browser';

const HEALTH_TONE = { OK: 'ok', STALE: 'bad', MISSING: 'busy' } as const;

/**
 * Re-takes an account's cookie jar: opens a throwaway browser profile on the
 * server, waits for the sign-in, stores what comes out and deletes the profile.
 *
 * A jar dies eventually — Google rotates session cookies, and a `STALE` badge
 * in the row above is the app noticing — so this is the button that keeps an
 * account working, not just the one that sets it up.
 */
function CapturePanel({
  account,
  remote,
  onDone,
  onClose,
}: {
  account: Account;
  remote: boolean;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const { progress, running, error, blocked, cancel, reopen } = useCookieCapture(account.id, onDone, {
    autoStart: true,
    remote,
  });
  const failed = progress?.state === 'FAILED';

  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Capturing cookies for {account.label}</h2>
        <div className="row">
          {running && <button onClick={() => void cancel()}>Cancel</button>}
          {!running && <button onClick={onClose}>Close</button>}
        </div>
      </div>

      <p
        className="small"
        style={{
          color: failed || error ? 'var(--bad)' : progress?.state === 'DONE' ? 'var(--ok)' : undefined,
        }}
      >
        {error ?? progress?.message ?? 'Starting…'}
        {progress?.state === 'WAITING_FOR_LOGIN' && typeof progress.secondsLeft === 'number' && (
          <span className="muted"> ({Math.ceil(progress.secondsLeft / 60)} min left)</span>
        )}
      </p>

      {progress?.viewUrl && <ReopenSignIn blocked={blocked} onReopen={reopen} />}

      <p className="small muted">
        Sign in with the Google account behind this channel. Do not sign out afterwards — that ends
        the session on Google&apos;s side and the jar with it.
      </p>
    </section>
  );
}

/** useSearchParams needs a boundary; the OAuth callback returns with ?connected=1. */
export default function AccountsPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Accounts />
    </Suspense>
  );
}

function Accounts() {
  const session = useSession();
  const params = useSearchParams();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const cookieInputs = useRef<Record<string, HTMLInputElement | null>>({});

  // Whether this server can open a browser itself. A jar expires eventually,
  // so re-capturing it belongs here rather than only in the wizard — the wizard
  // hides a step it considers done, which is every day but the first.
  const [capture, setCapture] = useState<CookieCapture | null>(null);
  // The capture opens a panel above the table rather than living in a row: it
  // carries a whole browser window when the server runs its own.
  const [capturing, setCapturing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([api<Account[]>('/accounts'), api<Status>('/status')]);
      setAccounts(list);
      setCapture(status.cookieCapture);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 401)) setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    if (session) void refresh();
  }, [session, refresh]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/accounts', { method: 'POST', body: JSON.stringify({ label, clientId, clientSecret }) });
      setLabel('');
      setClientId('');
      setClientSecret('');
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadCookies(account: Account, file: File) {
    setError(null);
    const body = new FormData();
    body.append('file', file);
    try {
      const result = await api<{ kept: number; dropped: number }>(`/accounts/${account.id}/cookies`, {
        method: 'POST',
        body,
      });
      alert(`Stored ${result.kept} cookies; discarded ${result.dropped} from unrelated domains.`);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  async function remove(account: Account) {
    if (!confirm(`Delete ${account.label}? Files already stored through it keep their video ids.`)) return;
    await api(`/accounts/${account.id}`, { method: 'DELETE' }).catch((failure) => setError(failure.message));
    await refresh();
  }

  if (!session) return <p className="muted">Checking your session…</p>;

  return (
    <>
      <h1>Accounts</h1>
      <p className="lede">
        Each account is one Google Cloud project plus one YouTube channel. Quota is charged per project,
        so a second channel only adds capacity if it brings its own project.
      </p>

      {params.get('connected') === '1' && (
        <div className="notice">Google authorisation completed. The account should read “connected” below.</div>
      )}

      <div className="split">
        <section className="panel">
          <h2>Add an account</h2>
          <form onSubmit={create}>
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
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <h2>Cookies</h2>
          <p className="small muted">
            API-uploaded videos are locked private, and a private video can only be fetched by an
            authenticated browser session — OAuth tokens do not work for playback. Hence a cookie jar per
            account.
          </p>
          <p className="small muted">
            {capture?.available ? (
              <>
                The safe way to produce one is <strong>Capture cookies</strong> below.{' '}
                {capture.mode === 'remote'
                  ? 'This server runs its own browser and shows it to you here; you sign in to YouTube in it.'
                  : `It opens ${capture.browserName} on the machine running this server and waits for you to sign in.`}{' '}
                Either way the profile is brand new and is deleted once the jar is out. Nothing ever opens it
                again, which is the point — Google rotates session cookies on use, so a jar shared with a
                browser you keep using is invalidated within minutes.
              </>
            ) : (
              <>
                The safe way to produce one is <span className="mono">pnpm run cookies</span> on the machine
                with the browser — this server has none of its own
                {capture ? <> ({capture.reason})</> : null}. It opens a throwaway profile, extracts the jar
                and deletes the profile, so nothing ever rotates that session again.
              </>
            )}{' '}
            Uploading a <span className="mono">cookies.txt</span> works too — export it from a private window
            and close the window <em>without</em> logging out. First-time setup walks the whole thing in{' '}
            <Link href="/setup">the wizard</Link>.
          </p>
          <p className="small" style={{ color: 'var(--warn)' }}>
            A jar authenticates every Google service, not just YouTube. Use a throwaway account that is not
            the recovery address for anything.
          </p>
        </section>
      </div>

      {capturing && accounts?.some((account) => account.id === capturing) && (
        <CapturePanel
          account={accounts.find((account) => account.id === capturing)!}
          remote={capture?.mode === 'remote'}
          onDone={refresh}
          onClose={() => setCapturing(null)}
        />
      )}

      <section className="panel">
        {accounts === null ? (
          <p className="empty">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="empty">No accounts yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>OAuth</th>
                <th>Cookies</th>
                <th>Quota today</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td data-label="" data-wide>
                    <strong>{account.label}</strong>
                    <div className="small mono muted">{account.clientId.slice(0, 24)}…</div>
                  </td>
                  <td data-label="OAuth">
                    <span className="badge" data-tone={account.connected ? 'ok' : 'bad'}>
                      {account.connected ? 'connected' : 'not connected'}
                    </span>
                  </td>
                  <td data-label="Cookies">
                    <div>
                      <span className="badge" data-tone={HEALTH_TONE[account.cookieHealth]}>
                        {account.cookieHealth.toLowerCase()}
                      </span>
                      <div className="small muted">checked {formatWhen(account.cookieCheckedAt)}</div>
                    </div>
                  </td>
                  <td className="muted" data-label="Quota today">
                    <div>
                      {account.quota.uploadsLeft} upload{account.quota.uploadsLeft === 1 ? '' : 's'} left
                      {/*
                        Says "used", and puts the used figure first: the line
                        underneath a header reading "Quota today" is read as
                        spend by everyone who sees it, and it used to show the
                        remainder, which inverts the meaning of the cell.
                      */}
                      <div className="small">
                        {account.quota.uploadsUsed} of {account.quota.dailyLimit} used today
                      </div>
                    </div>
                  </td>
                  <td data-label="" data-wide>
                    <div className="row">
                      <a className="button" href={`/api/accounts/${account.id}/connect`}>
                        {account.connected ? 'Re-authorise' : 'Connect'}
                      </a>
                      {capture?.available && (
                        <button
                          onClick={() => {
                            // Opened here rather than in the panel that follows:
                            // the panel starts its capture from an effect, and a
                            // window opened outside a click is a blocked popup.
                            if (capture.mode === 'remote') openSignInWindow();
                            setCapturing(account.id);
                          }}
                        >
                          Capture cookies
                        </button>
                      )}
                      <button onClick={() => cookieInputs.current[account.id]?.click()}>Upload cookies</button>
                      <input
                        ref={(element) => {
                          cookieInputs.current[account.id] = element;
                        }}
                        type="file"
                        accept=".txt"
                        hidden
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadCookies(account, file);
                          event.target.value = '';
                        }}
                      />
                      <button className="danger" onClick={() => remove(account)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
