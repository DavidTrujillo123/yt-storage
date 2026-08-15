'use client';

import { useEffect, useState } from 'react';
import { api, entryUrl, formatBytes, inlineUrl, previewKind } from '@/lib/api';
import type { RestoreState, StoredFile, TarEntry } from '@/lib/api';

/** Read into the page rather than streamed to an element, so both are capped. */
const TEXT_LIMIT = 200 * 1024;
const HEX_LIMIT = 4 * 1024;

/**
 * Reads the first `limit` bytes and hangs up.
 *
 * The point is the hanging up: a stored file can be gigabytes, and nothing here
 * needs more than the head of it to show what it is.
 */
async function readHead(url: string, limit: number): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not read it back (${response.status})`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).subarray(0, limit);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);

  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    out.set(chunk.subarray(0, out.length - offset), offset);
    offset += chunk.length;
  }
  return out;
}

/** Offset, 16 bytes of hex, and the printable ASCII beside it. */
function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

/**
 * Polls the restore of one file while the page is waiting on it.
 *
 * One second: fast enough that a bar moves, slow enough to be free next to a
 * download measured in hundreds of megabytes. The poll stops the moment the
 * thing it was waiting for arrives.
 */
function useRestoreProgress(fileId: string, active: boolean): RestoreState | null {
  const [state, setState] = useState<RestoreState | null>(null);

  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }
    let live = true;
    const poll = () => {
      api<RestoreState>(`/files/${fileId}/restore`)
        .then((next) => live && setState(next))
        // A failed poll says nothing about the restore itself, and the request
        // being waited on reports its own errors.
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [fileId, active]);

  return state;
}

/** The phase and its bar, or the phase alone when there is no total to divide by. */
function RestoreBar({ state }: { state: RestoreState }) {
  if (state.phase === 'idle') return null;

  const label =
    state.phase === 'downloading' ? 'Pulling the video back off YouTube' : 'Decoding the video';

  return (
    <div style={{ margin: '0.4rem 0' }}>
      <p className="small muted" style={{ margin: '0 0 0.25rem' }}>
        {label}
        {state.percent !== null ? ` — ${state.percent}%` : '…'}
      </p>
      {state.percent !== null && (
        <div className="progress" style={{ maxWidth: 'none' }}>
          <span style={{ width: `${state.percent}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * Shows a stored file without saving it.
 *
 * For anything already verified this means the API pulls the video back off
 * YouTube and decodes it before a single byte arrives — seconds, not
 * milliseconds, and real bandwidth. So a preview is opened deliberately, one
 * file at a time, and never prefetched.
 */
export function Preview({ file, onClose }: { file: StoredFile; onClose: () => void }) {
  const isBundle = file.name.toLowerCase().endsWith('.tar');

  // A bundle shows its contents; picking one opens that entry on its own.
  const [entries, setEntries] = useState<TarEntry[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);

  const kind = chosen !== null && entries ? previewKind(entries[chosen].name) : previewKind(file.name);
  const url = chosen !== null ? entryUrl(file.id, chosen, true) : inlineUrl(file.id);
  const reads = !isBundle || chosen !== null ? kind === 'text' || kind === null : false;
  const listing = isBundle && chosen === null;

  const [body, setBody] = useState<string | null>(null);
  const [bytesRead, setBytesRead] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(reads || isBundle);

  // An image, a video or a PDF is fetched by the element rather than by us, and
  // that request pays for the restore just the same — so the wait is over when
  // the element says so, not when an effect finishes.
  const rendered = !listing && !reads && kind !== null;
  const [mediaReady, setMediaReady] = useState(false);
  const waiting = !file.sourcePath && (loading || (rendered && !mediaReady));
  const restore = useRestoreProgress(file.id, waiting);

  useEffect(() => {
    // Escape backs out of an entry before it closes the whole sheet.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (chosen !== null) setChosen(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, chosen]);

  // The listing costs one restore; the API reads only the tar headers.
  useEffect(() => {
    if (!isBundle) return;
    let live = true;
    api<{ entries: TarEntry[] }>(`/files/${file.id}/entries`)
      .then((result) => live && setEntries(result.entries))
      .catch((failure: Error) => live && setError(failure.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [isBundle, file.id]);

  // Moving between the listing and an entry must not leave the previous
  // entry's bytes on screen under the new one's name.
  useEffect(() => {
    setBody(null);
    setBytesRead(0);
    setError(null);
    setMediaReady(false);
  }, [chosen]);

  useEffect(() => {
    if (!reads) return;
    let live = true;
    setLoading(true);
    readHead(url, kind === 'text' ? TEXT_LIMIT : HEX_LIMIT)
      .then((bytes) => {
        if (!live) return;
        setBytesRead(bytes.length);
        setBody(kind === 'text' ? new TextDecoder().decode(bytes) : hexDump(bytes));
      })
      .catch((failure: Error) => live && setError(failure.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [reads, kind, url]);

  const entry = chosen !== null && entries ? entries[chosen] : null;
  const shownSize = entry ? entry.size : file.size;
  const shownName = entry ? entry.name : file.name;
  // An imported row has no size until its first download, and a preview cannot
  // claim it was cut short against a length nobody has measured.
  const truncated = bytesRead > 0 && shownSize !== null && bytesRead < shownSize;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        {/* What this is on the left, what can be done with it on the right.
            The gap between the two is what makes them two groups rather than
            one row of five things, and the order never changes between a
            bundle, an entry and a plain file. */}
        <div className="row" style={{ marginBottom: '0.75rem' }}>
          {entry && (
            <button className="quiet" onClick={() => setChosen(null)} title="Back to the listing">
              ←
            </button>
          )}
          <strong>{shownName}</strong>
          <span className="small muted">{formatBytes(shownSize)}</span>
          <span style={{ marginLeft: 'auto' }} />
          <a
            className="button primary"
            href={chosen !== null ? entryUrl(file.id, chosen) : `/api/files/${file.id}/download`}
          >
            Download{entry ? ' this file' : ''}
          </a>
          <button className="quiet" onClick={onClose}>
            Close
          </button>
        </div>

        {waiting && (
          <>
            <p className="note">
              Not on disk any more — this is being pulled back off YouTube and decoded. How long
              that takes follows the size of the file, since the video carries about 383 KB of it
              per second. Once it is done the bytes are cached, and everything here is instant.
            </p>
            {restore && <RestoreBar state={restore} />}
          </>
        )}

        {listing && entries && (
          <p className="note">
            {entries.length} file{entries.length === 1 ? '' : 's'} in this bundle, stored as one video.
            Pick one to open it.
          </p>
        )}

        {!listing && kind === null && !loading && !error && (
          <p className="note">
            Nothing knows how to render a {shownName.split('.').pop()} file, so here are its bytes.
            {truncated && ` First ${formatBytes(bytesRead)} of ${formatBytes(shownSize)}.`}
          </p>
        )}

        {listing ? (
          <div className="viewer" style={{ display: 'block' }}>
            {error && <p className="error">{error}</p>}
            {loading && <p className="muted">Reading the archive back…</p>}
            {entries && entries.length === 0 && <p className="empty">The bundle is empty.</p>}
            {entries && entries.length > 0 && (
              <ul className="entries">
                {entries.map((item, index) => (
                  <li key={`${item.name}-${index}`}>
                    <button onClick={() => setChosen(index)}>
                      <span className="mono">{item.name}</span>
                      <span className="small muted">{formatBytes(item.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="viewer">
            {error && <p className="error">{error}</p>}
            {loading && <p className="muted">Reading it back…</p>}
            {kind === 'image' && (
              <img
                src={url}
                alt={shownName}
                onLoad={() => setMediaReady(true)}
                onError={() => setMediaReady(true)}
              />
            )}
            {kind === 'video' && (
              <video src={url} controls onLoadedData={() => setMediaReady(true)} onError={() => setMediaReady(true)} />
            )}
            {kind === 'audio' && (
              <audio src={url} controls onLoadedData={() => setMediaReady(true)} onError={() => setMediaReady(true)} />
            )}
            {kind === 'pdf' && (
              <iframe src={url} title={shownName} onLoad={() => setMediaReady(true)} />
            )}
            {body !== null && (
              <pre className={kind === null ? 'hex' : undefined}>
                {body}
                {kind === 'text' && truncated && '\n\n… truncated; download it for the rest.'}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
