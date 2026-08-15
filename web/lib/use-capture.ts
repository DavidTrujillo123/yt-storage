'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { CaptureProgress, CaptureState } from './api';

/** States where the server still has a browser open and something to report. */
const RUNNING: CaptureState[] = ['LAUNCHING', 'WAITING_FOR_LOGIN', 'CAPTURING'];

/**
 * Drives a cookie capture and follows where it got to.
 *
 * A sign-in runs for minutes — a password, a second factor, sometimes a device
 * prompt — far too long to hold an HTTP request open through a browser and
 * whatever proxies sit in front of it. So starting one returns immediately and
 * this polls for state.
 *
 * Nothing about the capture is tracked here: every field shown comes back from
 * the server, which is what lets a reload, or a second tab, pick up a capture
 * already in flight instead of starting a competing one.
 *
 * A hook rather than a component because the two callers want the same
 * machinery behind very different surfaces — a whole explanatory step in the
 * wizard, one button in a table row on the accounts page.
 */
export function useCookieCapture(accountId: string, onDone: () => Promise<void> | void) {
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = progress !== null && RUNNING.includes(progress.state);

  // Adopt a capture that outlived the page rather than compete with it.
  useEffect(() => {
    void api<CaptureProgress>(`/accounts/${accountId}/cookies/capture`)
      .then((current) => {
        if (current.state !== 'IDLE') setProgress(current);
      })
      .catch(() => undefined);
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

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      setProgress(
        await api<CaptureProgress>(`/accounts/${accountId}/cookies/capture`, { method: 'POST' }),
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setStarting(false);
    }
  }, [accountId]);

  const cancel = useCallback(async () => {
    try {
      await api(`/accounts/${accountId}/cookies/capture`, { method: 'DELETE' });
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [accountId]);

  return { progress, running, starting, error, start, cancel };
}
