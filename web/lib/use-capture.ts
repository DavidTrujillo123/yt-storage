'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { BrowserProfile, CaptureProgress, CaptureState } from './api';

/** States where the server still has a browser open and something to report. */
const RUNNING: CaptureState[] = ['LAUNCHING', 'WAITING_FOR_LOGIN', 'CAPTURING'];

/**
 * Drives the capture the API can do on its own machine, and follows where it
 * got to.
 *
 * This is the *second* way to get a jar and only exists when the API runs
 * natively, because then the browser profiles on its disk are yours: `profiles`
 * lists the ones already signed in to YouTube, and picking one copies its
 * session. Under Docker there is no such thing — the paste in `CookiePaste` is
 * what works there, and everywhere else.
 *
 * A sign-in runs for minutes when one is needed at all, far too long to hold an
 * HTTP request open, so starting returns immediately and this polls for state.
 */
export function useCookieCapture(accountId: string, onDone: () => Promise<void> | void) {
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const running = progress !== null && RUNNING.includes(progress.state);

  const start = useCallback(
    async (profile?: string) => {
      setStarting(true);
      setError(null);
      try {
        setProgress(
          await api<CaptureProgress>(`/accounts/${accountId}/cookies/capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ profile }),
          }),
        );
      } catch (failure) {
        setError((failure as Error).message);
      } finally {
        setStarting(false);
      }
    },
    [accountId],
  );

  // Null until the list is in, so the page can tell "still looking" from
  // "nothing here is signed in", which are very different things to say.
  const reloadProfiles = useCallback(() => {
    setProfiles(null);
    setRound((n) => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    void api<{ profiles: BrowserProfile[] }>(`/accounts/${accountId}/cookies/capture/profiles`)
      .then((found) => live && setProfiles(found.profiles))
      .catch(() => live && setProfiles([]));
    return () => {
      live = false;
    };
  }, [accountId, round]);

  // Adopt a capture that outlived the page rather than compete with it.
  useEffect(() => {
    let live = true;
    void api<CaptureProgress>(`/accounts/${accountId}/cookies/capture`)
      .then((current) => {
        if (live && current.state !== 'IDLE') setProgress(current);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [accountId]);

  useEffect(() => {
    if (!running) return;

    let live = true;
    const timer = setInterval(async () => {
      try {
        const next = await api<CaptureProgress>(`/accounts/${accountId}/cookies/capture`);
        if (!live) return;
        setProgress(next);
        // Only worth a round trip once there is something new to read: this is
        // what flips the account to healthy wherever it is displayed.
        if (next.state === 'DONE') await onDone();
      } catch (failure) {
        if (live) setError((failure as Error).message);
      }
    }, 2000);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, accountId, onDone]);

  const cancel = useCallback(async () => {
    try {
      await api(`/accounts/${accountId}/cookies/capture`, { method: 'DELETE' });
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [accountId]);

  return { progress, profiles, running, starting, error, start, cancel, reloadProfiles };
}
