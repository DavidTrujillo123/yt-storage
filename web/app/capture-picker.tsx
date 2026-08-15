'use client';

import type { useCookieCapture } from '@/lib/use-capture';

/**
 * The capture, in whichever of its two shapes this deployment can do.
 *
 * **Remote** — the browser the server ships, opened in a window of its own and
 * shown to you over VNC. Nothing is installed anywhere and nothing runs on your
 * machine, which is what makes `docker compose up` the entire install. You sign
 * in to Google inside that window; the profile behind it is thrown away once the
 * jar is out, so no second client ever rotates that session.
 *
 * **Local** — only when the API runs natively, which means the browser profiles
 * on its machine are yours. Then there is nothing to sign in to: the profiles
 * already signed in to YouTube are listed, and picking one copies its session.
 * Faster, at the price of sharing a session the browser keeps using.
 *
 * Shared by the wizard's last step and the accounts page, which want the same
 * machinery behind different surroundings.
 */
export function CapturePicker({
  capture,
  accountLabel,
  browserName,
  emptyExtra,
}: {
  capture: ReturnType<typeof useCookieCapture>;
  accountLabel: string;
  browserName: string | null;
  /** What to offer when nothing is signed in; the wizard has more room for it. */
  emptyExtra?: React.ReactNode;
}) {
  const { progress, profiles, running, starting, error, start, cancel, reloadProfiles } = capture;

  const status = (progress || error) && (
    <p
      className="small"
      style={{
        color:
          error || progress?.state === 'FAILED'
            ? 'var(--bad)'
            : progress?.state === 'DONE'
              ? 'var(--ok)'
              : undefined,
      }}
    >
      {error ?? progress?.message}
      {progress?.state === 'WAITING_FOR_LOGIN' && typeof progress.secondsLeft === 'number' && (
        <span className="muted"> ({Math.ceil(progress.secondsLeft / 60)} min left)</span>
      )}
    </p>
  );


  if (profiles === null) return <p className="small muted">Looking for signed-in browser profiles…</p>;

  return (
    <>
      {profiles.length === 0 ? (
        <>
          <p className="small muted">
            No browser profile on the machine running this server is signed in to Google, so there is
            nothing to copy yet. Sign in to YouTube in {browserName ?? 'Brave, Chrome, Chromium, Edge or Vivaldi'} as
            you normally would, then look again. Safari and Firefox cannot be read at all.
          </p>
          <div className="row">
            <button onClick={reloadProfiles}>Look again</button>
          </div>
          {emptyExtra}
        </>
      ) : (
        <>
          <p className="small muted">
            Pick the profile whose YouTube session belongs to <strong>{accountLabel}</strong>. Its
            cookies are copied as they are — no window opens and no password is typed.
          </p>

          <div className="stack" style={{ gap: '0.35rem', margin: '0.5rem 0' }}>
            {profiles.map((profile) => (
              <div key={profile.id} className="row">
                <button
                  className={profile.youtube ? 'primary' : undefined}
                  disabled={starting || running}
                  onClick={() => void start(profile.id)}
                >
                  {profile.browserName} — {profile.label}
                  {profile.email ? ` (${profile.email})` : ''}
                </button>
                {!profile.youtube && (
                  <span className="small muted">
                    signed in to Google, but not to YouTube — this one probably has nothing usable
                  </span>
                )}
              </div>
            ))}
            <div className="row">
              <button onClick={reloadProfiles} disabled={starting || running}>
                Refresh list
              </button>
              {running && <button onClick={() => void cancel()}>Cancel</button>}
            </div>
          </div>

          <p className="small" style={{ color: 'var(--warn)' }}>
            This jar shares its session with the profile it came from. Keep browsing YouTube there
            and Google may rotate the session, which invalidates the jar — measured here at roughly
            twenty and five minutes. An account you do not browse with, or a profile you then leave
            alone, is what avoids that.
          </p>
        </>
      )}

      {status}
    </>
  );
}
