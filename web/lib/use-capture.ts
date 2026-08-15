'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { CaptureProgress, CaptureState } from './api';

/** States where the server still has a browser open and something to report. */
const RUNNING: CaptureState[] = ['LAUNCHING', 'WAITING_FOR_LOGIN', 'CAPTURING'];

/**
 * A window of its own, not a frame in the page. Signing in to Google inside a
 * panel in someone else's page is exactly what a phishing site looks like, and
 * it reads that way even when it is not; a separate window with a real browser
 * in it is the same thing without the disguise.
 */
const SIGN_IN_WINDOW = 'yts-signin';
const WINDOW_FEATURES = 'width=1300,height=880,menubar=no,toolbar=no';

/**
 * Opens the sign-in window empty, or hands back the one already open.
 *
 * Must be called inside the click that leads to a capture: a window opened
 * later, once the server says where to point it, has no user gesture behind it
 * and every popup blocker stops it. Naming the window is what makes the second
 * call — the hook's, a moment later — reuse this one instead of asking for a
 * new popup that would be blocked.
 */
export function openSignInWindow(): Window | null {
  const opened = window.open('', SIGN_IN_WINDOW, WINDOW_FEATURES);
  // Only ever paint the placeholder over a blank window; the same call reaches
  // a window that is already showing the browser.
  if (opened && opened.location.href === 'about:blank') {
    opened.document.write(
      '<title>Sign in to Google</title><body style="margin:0;display:grid;place-items:center;' +
        'height:100vh;font:14px system-ui;background:#111;color:#bbb">Starting the browser…</body>',
    );
  }
  return opened;
}

interface Options {
  /**
   * Starts one as soon as this mounts — for a panel that only exists because
   * someone just asked for a capture, where a second button to press would be
   * a step with no decision in it.
   */
  autoStart?: boolean;
  /**
   * Whether the server runs the browser itself, which is the case that needs a
   * window opened for it. Known before the capture starts, from `/status`.
   */
  remote?: boolean;
}

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
 * wizard, one panel on the accounts page.
 */
export function useCookieCapture(
  accountId: string,
  onDone: () => Promise<void> | void,
  { autoStart = false, remote = false }: Options = {},
) {
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Null when the browser blocked the popup, which is worth telling someone. */
  const [blocked, setBlocked] = useState(false);
  const signIn = useRef<Window | null>(null);
  const pointed = useRef(false);
  const running = progress !== null && RUNNING.includes(progress.state);

  /**
   * Opened empty, synchronously, inside the click that asked for it — a window
   * opened later, when the address finally exists, is a popup with no gesture
   * behind it and every browser blocks that.
   */
  const openWindow = useCallback(() => {
    if (!remote) return;
    pointed.current = false;
    const opened = openSignInWindow();
    signIn.current = opened;
    setBlocked(opened === null);
  }, [remote]);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    openWindow();
    try {
      setProgress(
        await api<CaptureProgress>(`/accounts/${accountId}/cookies/capture`, { method: 'POST' }),
      );
    } catch (failure) {
      signIn.current?.close();
      setError((failure as Error).message);
    } finally {
      setStarting(false);
    }
  }, [accountId, openWindow]);

  /** For a window that was blocked, or that someone closed by hand. */
  const reopen = useCallback(() => {
    if (!progress?.viewUrl) return;
    const opened = window.open(progress.viewUrl, SIGN_IN_WINDOW, WINDOW_FEATURES);
    signIn.current = opened;
    pointed.current = opened !== null;
    setBlocked(opened === null);
  }, [progress?.viewUrl]);

  // Adopt a capture that outlived the page rather than compete with it. Only
  // once that answer is in can autoStart know whether there is anything to
  // start; starting first would collide with the capture already running.
  useEffect(() => {
    let live = true;
    void api<CaptureProgress>(`/accounts/${accountId}/cookies/capture`)
      .then((current) => {
        if (!live) return;
        if (current.state !== 'IDLE') setProgress(current);
        else if (autoStart) void start();
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // start is stable for an accountId, and autoStart is a mount-time decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // The window is opened before the address for it exists, so pointing it at
  // the browser is a second step that waits for the server to say it is up.
  useEffect(() => {
    const target = progress?.viewUrl;
    if (!target || pointed.current) return;
    if (signIn.current && !signIn.current.closed) {
      signIn.current.location.replace(target);
      pointed.current = true;
    }
  }, [progress?.viewUrl]);

  // Nothing to look at once the browser is gone, and a window left showing a
  // dead connection reads as a failure even when the jar was stored.
  useEffect(() => {
    if (progress && !RUNNING.includes(progress.state)) {
      signIn.current?.close();
      signIn.current = null;
    }
  }, [progress]);

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

  return { progress, running, starting, error, blocked, start, cancel, reopen };
}
