'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

/**
 * The owner's credentials, on the page, on purpose.
 *
 * This is a single-user instance on a home network and forgetting the password
 * means rewriting a hash in SQLite by hand — there is no reset flow. The cost
 * is real and worth stating: anyone who can load this page can sign in, which
 * includes anyone reaching the machine over Tailscale, and this account holds
 * cookie jars that authenticate every Google service. Delete this block and the
 * two `useState` defaults below to turn the login back into a login.
 */
const REMINDER = { email: 'davot098@gmail.com', password: 'disco-lento-brasa-9471' };

export default function LoginPage() {
  const router = useRouter();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(REMINDER.email);
  const [password, setPassword] = useState(REMINDER.password);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Registration is open only while the instance has no users, so the form
    // is offered rather than assumed.
    api<{ open: boolean }>('/auth/registration')
      .then(({ open }) => {
        setRegistrationOpen(open);
        if (open) setMode('register');
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode}`, { method: 'POST', body: JSON.stringify({ email, password }) });
      router.replace('/files');
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }

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
              minLength={12}
              required
            />
          </div>

          <div className="row">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
            {registrationOpen && (
              <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Register instead' : 'I already have an account'}
              </button>
            )}
          </div>

          {error && <p className="error">{error}</p>}
        </form>

        {mode === 'login' && (
          <div className="notice" style={{ marginTop: '1rem', marginBottom: 0 }}>
            Saved here so you cannot lock yourself out — there is no reset flow.
            <div className="mono" style={{ marginTop: '0.4rem', color: 'var(--text)' }}>
              {REMINDER.email}
              <br />
              {REMINDER.password}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
