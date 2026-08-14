'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError, formatWhen } from '@/lib/api';
import type { Account } from '@/lib/api';
import { useSession } from '@/lib/use-session';

const HEALTH_TONE = { OK: 'ok', STALE: 'bad', MISSING: 'busy' } as const;

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

  const refresh = useCallback(async () => {
    try {
      setAccounts(await api<Account[]>('/accounts'));
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
            The safe way to produce one is <span className="mono">pnpm run cookies</span> on the machine with
            the browser: it opens a throwaway profile, extracts the jar and deletes the profile, so nothing
            ever rotates that session again. Uploading a <span className="mono">cookies.txt</span> below works
            too — export it from a private window and close the window <em>without</em> logging out.
          </p>
          <p className="small" style={{ color: 'var(--warn)' }}>
            A jar authenticates every Google service, not just YouTube. Use a throwaway account that is not
            the recovery address for anything.
          </p>
        </section>
      </div>

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
                      <div className="small">
                        {account.quota.remaining} of {account.quota.used + account.quota.remaining} units
                      </div>
                    </div>
                  </td>
                  <td data-label="" data-wide>
                    <div className="row">
                      <a className="button" href={`/api/accounts/${account.id}/connect`}>
                        {account.connected ? 'Re-authorise' : 'Connect'}
                      </a>
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
