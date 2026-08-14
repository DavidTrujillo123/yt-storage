'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import type { Bootstrap } from '@/lib/api';

/**
 * The password the API seeds an instance with.
 *
 * Held here rather than served: the API only ever says *whether* the shipped
 * credential is still in use, never what it is. It can only be this value —
 * a password set through ADMIN_PASSWORD is the operator's own and the flag is
 * never raised for it — so the page can fill it in without a secret crossing
 * the wire.
 */
const SEEDED_PASSWORD = 'Abcd1234';

export default function LoginPage() {
  const router = useRouter();
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Two things the page cannot assume: whether registration is still open
    // (it closes as soon as the instance has a user) and whether this instance
    // is still on the credential it shipped with.
    api<Bootstrap>('/auth/bootstrap')
      .then((info) => {
        setBootstrap(info);
        if (info.registrationOpen && !info.defaultAdmin) setMode('register');
        if (info.defaultAdmin) {
          setEmail(info.defaultAdmin);
          setPassword(SEEDED_PASSWORD);
        }
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify({ email, password }) });
      // Straight to the wizard while the shipped password is still in place:
      // changing it is its first step.
      router.replace(bootstrap?.defaultAdmin ? '/setup' : '/files');
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  const minLength = bootstrap?.minPasswordLength ?? 8;

  return (
    <>
      <h1>{mode === 'register' ? 'Create the first account' : 'Sign in'}</h1>
      <p className="lede">
        {mode === 'register'
          ? 'Registration closes as soon as this instance has a user.'
          : 'The session lives in an httpOnly cookie; nothing is stored in the browser.'}
      </p>

      <section className="panel" style={{ maxWidth: '24rem' }}>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={mode === 'register' ? minLength : undefined}
              required
            />
          </div>

          <div className="row">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
            {bootstrap?.registrationOpen && (
              <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Register instead' : 'I already have an account'}
              </button>
            )}
          </div>

          {error && <p className="error">{error}</p>}
        </form>

        {bootstrap?.defaultAdmin && (
          <div className="notice" style={{ marginTop: '1rem', marginBottom: 0 }}>
            This instance is still using the password it shipped with, filled in above. Anyone who
            can reach this page can sign in and read the Google credentials it holds — change it as
            soon as you are in.
          </div>
        )}
      </section>
    </>
  );
}
