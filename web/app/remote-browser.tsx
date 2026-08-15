'use client';

/**
 * The line under the button when the server's browser is up.
 *
 * The browser itself is a separate window, not a frame in this page: a Google
 * sign-in embedded in someone else's page is indistinguishable from a phishing
 * form, and the app should not teach anyone that it is normal. The window is
 * opened inside the click that starts the capture, before the address for it
 * exists, because a popup opened later has no user gesture behind it and is
 * blocked — `blocked` says that happened anyway, which is the one case where
 * someone has to press something a second time.
 */
export function ReopenSignIn({ blocked, onReopen }: { blocked: boolean; onReopen: () => void }) {
  return (
    <p className="small" style={{ color: blocked ? 'var(--warn)' : undefined }}>
      {blocked ? (
        <>
          Your browser blocked the sign-in window. Allow popups for this site, or{' '}
          <button onClick={onReopen}>open it now</button>.
        </>
      ) : (
        <>
          The sign-in window is open. Closed it by accident?{' '}
          <button onClick={onReopen}>Bring it back</button> — the capture is still running.
        </>
      )}
    </p>
  );
}
