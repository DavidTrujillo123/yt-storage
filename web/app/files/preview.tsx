'use client';

import { useEffect, useState } from 'react';
import { api, entryUrl, formatBytes, inlineUrl, previewKind } from '@/lib/api';
import type { StoredFile, TarEntry } from '@/lib/api';

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

  const [body, setBody] = useState<string | null>(null);
  const [bytesRead, setBytesRead] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(reads || isBundle);

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
  const truncated = bytesRead > 0 && bytesRead < shownSize;
  const listing = isBundle && chosen === null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="row" style={{ marginBottom: '0.75rem' }}>
          {entry && (
            <button onClick={() => setChosen(null)} title="Back to the listing">
              ←
            </button>
          )}
          <strong>{shownName}</strong>
          <span className="small muted">{formatBytes(shownSize)}</span>
          <span style={{ marginLeft: 'auto' }} />
          <a
            className="button"
            href={chosen !== null ? entryUrl(file.id, chosen) : `/api/files/${file.id}/download`}
          >
            Download{entry ? ' this file' : ''}
          </a>
          <button onClick={onClose}>Close</button>
        </div>

        {!file.sourcePath && loading && (
          <p className="small muted">
            Not on disk any more — this is being pulled back off YouTube and decoded, which takes a
            few seconds. After that it is cached, and everything here is instant.
          </p>
        )}

        {listing && entries && (
          <p className="small muted">
            {entries.length} file{entries.length === 1 ? '' : 's'} in this bundle, stored as one video.
            Pick one to open it.
          </p>
        )}

        {!listing && kind === null && !loading && !error && (
          <p className="small muted">
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
            {kind === 'image' && <img src={url} alt={shownName} />}
            {kind === 'video' && <video src={url} controls />}
            {kind === 'audio' && <audio src={url} controls />}
            {kind === 'pdf' && <iframe src={url} title={shownName} />}
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
