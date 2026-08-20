'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, formatBytes, formatWhen, uploadFiles } from '@/lib/api';
import type { FileStatus, Status, StoredFile } from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { Preview } from './preview';
import { RebuildFromChannel } from './rebuild';

const TONE: Record<FileStatus, 'ok' | 'busy' | 'bad'> = {
  PENDING: 'busy',
  ENCODING: 'busy',
  UPLOADING: 'busy',
  PROCESSING: 'busy',
  VERIFYING: 'busy',
  READY: 'ok',
  FAILED: 'bad',
};

/** Mirrors MAX_BUNDLE_ENTRIES on the server. */
const MAX_FILES = 500;

/**
 * What one upload may weigh, and it is disk that decides now rather than
 * memory.
 *
 * This used to be 2 GiB because the encoder read the whole file in and kept
 * three copies of it, because ffmpeg's `-shortest` buffered gigabytes on its
 * way to the muxer, and because the decoder assembled the whole file again to
 * check its hash. All three are gone: measured on this machine, encoding a
 * 1 GiB payload peaks at about 200 MiB of node and 860 MiB of ffmpeg, and
 * decoding it peaks at about 520 MiB — the same figures a quarter-gigabyte
 * payload produces, because none of them grow with the file any more.
 *
 * What does grow is scratch space. An encode writes a master roughly five
 * times the payload beside the original, and verification later pulls a copy
 * back down and decodes it, so budget something like seven times what is
 * uploaded. This matches `MAX_UPLOAD_BYTES` on the server, which is the outer
 * bound the API enforces.
 */
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;

/** What the row is actually waiting on, in words rather than a state name. */
function explain(file: StoredFile): string {
  switch (file.status) {
    case 'PENDING':
      return 'queued';
    case 'ENCODING':
      return 'encoding to video';
    case 'UPLOADING':
      return 'uploading to YouTube';
    case 'PROCESSING':
      return file.verifyAttempts
        ? `waiting for a 1080p rendition · checked ${file.verifyAttempts}× · last ${formatWhen(file.lastCheckedAt)}`
        : 'waiting for YouTube to transcode';
    case 'VERIFYING':
      return 'reading it back and checking the hash';
    case 'READY':
      return file.importedAt
        ? 'found on the channel — size and hash confirmed on first download'
        : 'stored on YouTube, local copy released';
    case 'FAILED':
      return 'failed';
  }
}

export default function FilesPage() {
  const session = useSession();
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState<StoredFile | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, summary] = await Promise.all([api<StoredFile[]>('/files'), api<Status>('/status')]);
      setFiles(list);
      setStatus(summary);
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 401)) setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void refresh();
    // Polling, not websockets: one user, and the pipeline moves in minutes.
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [session, refresh]);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (picked.length === 0) return;

    const total = picked.reduce((sum, file) => sum + file.size, 0);

    // Checked here rather than discovered mid-request. Both of these used to
    // fail as a dropped connection with nothing in the server's log, which
    // reads like a broken app rather than a limit.
    if (picked.length > MAX_FILES) {
      setError(
        `${picked.length} files at once; the limit is ${MAX_FILES} per bundle. Split the selection.`,
      );
      return;
    }
    if (total > MAX_TOTAL_BYTES) {
      setError(
        `${formatBytes(total)} in one upload. An encode needs several times the payload in scratch space, so keep it under ${formatBytes(MAX_TOTAL_BYTES)}.`,
      );
      return;
    }

    // More than one file becomes a single archive, and therefore a single
    // upload. Worth saying out loud: uploads, not bytes, are what runs out.
    if (picked.length > 1) {
      const label = picked[0].webkitRelativePath?.split('/')[0];
      const what = label ? `the folder “${label}”` : `${picked.length} files`;
      if (!confirm(`Bundle ${what} (${picked.length} files, ${formatBytes(total)}) into one archive and upload it as one video?`)) {
        return;
      }
    }

    setError(null);
    setUploadPercent(0);
    try {
      await uploadFiles(picked, setUploadPercent);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setUploadPercent(null);
    }
  }

  async function retry(file: StoredFile) {
    setError(null);
    await api(`/files/${file.id}/retry`, { method: 'POST' }).catch((failure) =>
      setError(failure.message),
    );
    await refresh();
  }

  async function rename(file: StoredFile) {
    // A prompt rather than an inline editor: renaming is rare, the old name is
    // the sensible starting point, and Escape has to leave the row untouched.
    const asked = prompt(`Rename ${file.name} to:`, file.name);
    if (asked === null || asked.trim() === file.name) return;

    setError(null);
    // The reply says how many videos kept the old title, which only happens on
    // an account connected before this app asked for the write scope. It is
    // worth surfacing: the file is renamed either way, the channel is not.
    const result = await api<{ stale: number; message?: string }>(`/files/${file.id}/name`, {
      method: 'POST',
      body: JSON.stringify({ name: asked }),
    }).catch((failure) => {
      setError(failure.message);
      return null;
    });

    if (result?.message) setError(result.message);
    await refresh();
  }

  async function remove(file: StoredFile) {
    // Two different questions, because they have different consequences and
    // only one of them can be undone. Forgetting a row is recoverable — Rebuild
    // from channel finds it again — and deleting the video is not, so it is
    // only ever offered when an account can actually do it, and never as the
    // default answer.
    const canManage = status?.accounts.some((account) => account.canManage);
    if (!confirm(`Delete ${file.name}? This forgets it here.`)) return;

    const alsoOnYoutube =
      canManage &&
      confirm(
        `Delete the video on YouTube too?\n\n` +
          'OK deletes it for good. Cancel keeps it, so this file can be rebuilt from the channel later.',
      );

    await api(`/files/${file.id}${alsoOnYoutube ? '?youtube=1' : ''}`, { method: 'DELETE' }).catch(
      (failure) => setError(failure.message),
    );
    await refresh();
  }

  if (!session) return <p className="muted">Checking your session…</p>;

  return (
    <>
      <h1>Files</h1>
      <p className="lede">
        {status
          ? status.canUpload
            ? `${status.uploadsLeftToday} upload${status.uploadsLeftToday === 1 ? '' : 's'} left today across your accounts.`
            : 'No account can upload right now — check the Accounts page.'
          : ' '}
      </p>

      <section className="panel">
        <h2>Store a file</h2>
        <div className="row">
          <button
            className="primary"
            onClick={() => input.current?.click()}
            disabled={uploadPercent !== null}
          >
            Choose files
          </button>
          <button onClick={() => folder.current?.click()} disabled={uploadPercent !== null}>
            Choose a folder
          </button>
          <input ref={input} type="file" multiple hidden onChange={onPick} />
          {/* webkitdirectory is not in React's typings and is the only way to
              pick a whole folder; its structure arrives in webkitRelativePath. */}
          <input
            ref={folder}
            type="file"
            hidden
            onChange={onPick}
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          />
        </div>

        {/* Under the buttons, not beside them: the sentence explains those two
            controls, and a reader groups it with whatever it sits closest to. */}
        <p className="note">
          Several files become one archive, and one upload — which is the resource that runs out.
        </p>

        {/* The bar and its label are one object, and both belong under the
            controls that started the work rather than in the row with them. */}
        {uploadPercent !== null && (
          <div style={{ marginTop: '0.6rem' }}>
            <p className="small muted" style={{ margin: '0 0 0.25rem' }}>
              {uploadPercent < 50
                ? `Reading the files… ${uploadPercent * 2}%`
                : uploadPercent < 100
                  ? `Uploading ${(uploadPercent - 50) * 2}%`
                  : 'Handing over to the encoder…'}
            </p>
            <div className="progress" style={{ maxWidth: 'none' }}>
              <span style={{ width: `${uploadPercent}%` }} />
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        {status && (
          <div className="group">
            <h2>Recover the list</h2>
            <RebuildFromChannel accounts={status.accounts} onDone={refresh} />
          </div>
        )}
      </section>

      <section className="panel">
        <h2>
          Stored{files && files.length > 0 ? ` — ${files.length} file${files.length === 1 ? '' : 's'}` : ''}
        </h2>
        {files === null ? (
          <p className="empty">Loading…</p>
        ) : files.length === 0 ? (
          <p className="empty">
            Nothing stored yet. Pick a file above — or, if this list should not be empty,
            rebuild it from the channel.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Size</th>
                <th>State</th>
                <th>Video</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr key={file.id}>
                  <td data-label="" data-wide>
                    <strong>{file.name}</strong>
                    <div className="small muted">{explain(file)}</div>
                    {file.error && <div className="small mono" style={{ color: 'var(--bad)' }}>{file.error}</div>}
                  </td>
                  <td className="muted num" data-label="Size">
                    {formatBytes(file.size)}
                  </td>
                  <td data-label="State">
                    <div>
                      <span className="badge" data-tone={TONE[file.status]}>
                        {file.status.toLowerCase()}
                      </span>
                      {file.progress > 0 && file.progress < 100 && file.status !== 'READY' && (
                        <div className="progress">
                          <span style={{ width: `${file.progress}%` }} />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="mono muted" data-label="Video">
                    {file.videoId ? (
                      <a href={`https://www.youtube.com/watch?v=${file.videoId}`} target="_blank" rel="noreferrer">
                        {file.videoId}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  {/* Ordered by how often each is wanted, and weighted to
                      match: one solid button at most per row, the everyday
                      ones plain, and the destructive one last and quiet so it
                      is never the thing the hand reaches for by habit. */}
                  <td className="actions" data-label="" data-wide>
                    <div className="row">
                      {file.status === 'FAILED' && (
                        <button className="primary" onClick={() => retry(file)}>
                          Retry
                        </button>
                      )}
                      {file.status !== 'PENDING' && file.status !== 'ENCODING' && (
                        <>
                          <button onClick={() => setPreviewing(file)}>Preview</button>
                          <a className="button quiet" href={`/api/files/${file.id}/download`}>
                            Download
                          </a>
                        </>
                      )}
                      <button className="quiet" onClick={() => rename(file)}>
                        Rename
                      </button>
                      <button className="danger quiet" onClick={() => remove(file)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {previewing && <Preview file={previewing} onClose={() => setPreviewing(null)} />}
    </>
  );
}
