'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import type { Account, ImportResult } from '@/lib/api';

/**
 * Rebuilds the catalogue from a channel — for the day this list is empty and
 * the channel is not.
 *
 * That day arrives more often than losing a database sounds like it should:
 * this app's rows live in one SQLite file, and a different working directory, a
 * fresh container volume or a restored machine all produce the same symptom —
 * every video still private and intact on YouTube, and nothing here to name
 * them. Each upload writes its filename and hash into the video's description
 * for exactly this, and this is what reads them back.
 *
 * What it will not do is guess. Videos that are not containers are listed by
 * title and left alone; a row invented for one would carry a hash that no
 * download could ever match, which reads as corruption rather than as a video
 * that was never ours.
 */
export function RebuildFromChannel({
  accounts,
  onDone,
}: {
  accounts: Account[];
  onDone: () => Promise<void> | void;
}) {
  const connected = accounts.filter((account) => account.connected);
  const [accountId, setAccountId] = useState(connected[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  if (connected.length === 0) return null;

  async function rebuild() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const found = await api<ImportResult>('/files/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: accountId || connected[0].id }),
      });
      setResult(found);
      await onDone();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row">
        {connected.length > 1 && (
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {connected.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        )}
        <button onClick={() => void rebuild()} disabled={busy}>
          {busy ? 'Reading the channel…' : 'Rebuild from channel'}
        </button>
        <span className="small muted">
          Finds files that are on YouTube but missing here — after a lost database, or a fresh
          install pointed at the same channel.
        </span>
      </div>

      {error && <p className="error">{error}</p>}

      {result && (
        <>
          <p className="small" style={{ color: result.imported ? 'var(--ok)' : undefined }}>
            {result.imported === 0
              ? `Nothing new — all ${result.alreadyKnown} container${result.alreadyKnown === 1 ? '' : 's'} on that channel are already listed.`
              : `Recovered ${result.imported} file${result.imported === 1 ? '' : 's'}` +
                (result.alreadyKnown ? `, ${result.alreadyKnown} already listed` : '') +
                '. Sizes fill in the first time each one is downloaded.'}
            {result.truncated && ' That channel is longer than one pass — run it again for the rest.'}
          </p>

          {result.unrecognised.length > 0 && (
            <details className="small muted">
              <summary>
                {result.unrecognised.length} video
                {result.unrecognised.length === 1 ? '' : 's'} left alone
              </summary>
              <p>
                Not yt-storage containers, so nothing was invented for them. If one of these really
                holds a file, it was uploaded by something else and only decoding it would tell.
              </p>
              <ul>
                {result.unrecognised.map((video) => (
                  <li key={video.videoId}>
                    <span className="mono">{video.videoId}</span> — {video.title || 'untitled'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </>
  );
}
