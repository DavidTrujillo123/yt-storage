import { StreamableFile } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Response } from 'express';

/**
 * Turning a path plus a byte window into an HTTP response the browser trusts.
 *
 * Two things a download of this size cannot do without, and neither was being
 * sent: a Content-Length, so the browser knows when it has the whole thing
 * rather than guessing from a chunked stream that ended; and Range support, so
 * an interrupted transfer resumes where it stopped instead of starting the
 * whole file again. A media element asks for a range before it plays anything,
 * and a 200 with the entire body in answer to `Range:` is what leaves a video
 * unseekable and a resumed download back at zero.
 */

/** One byte window of a file, half-open at neither end: both bounds included. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The range the client asked for, clamped to what exists.
 *
 * `null` means "no range, send all of it". `'unsatisfiable'` means the client
 * asked for bytes past the end, which is a 416 and not a full body — answering
 * that with the whole file is how a stalled download turns into an endless one.
 * A multi-range request is deliberately treated as no range: multipart/byteranges
 * buys nothing here, and a full body is a legal answer to it.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // `bytes=-N`: the last N bytes.
    const wanted = Number(rawEnd);
    if (wanted <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * A Content-Disposition that survives a name with a space or an accent in it.
 *
 * `filename=` is bytes, not a URL: percent-encoding the whole name saved
 * `[Daemon Anime] Berserk.mp4` as `%5BDaemon%20Anime%5D%20Berserk.mp4`, which is
 * what a file nobody can find looks like. The quoted form therefore carries an
 * ASCII fallback with the awkward characters replaced, and `filename*` carries
 * the real name in the encoding RFC 5987 defines for it.
 */
export function dispositionOf(name: string, inline: boolean): string {
  const leaf = name.split('/').pop() || 'download';
  // Quotes and backslashes would end the quoted string early; control
  // characters and non-ASCII have no meaning in it at all.
  const ascii = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\uffff]/g, '_')
    .replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(leaf)}`;
}

export interface ServeOptions {
  /** Where the bytes are. */
  path: string;
  /**
   * The window of that file the response is about, before any Range is applied:
   * where it starts and how long it is. A length rather than an end offset
   * because an empty entry has no last byte, and `start - 1` for one is a range
   * that reads the byte before it.
   */
  window: { start: number; length: number };
  contentType: string;
  disposition: string;
  etag: string;
  /** The client's `Range:` header, if it sent one. */
  range?: string;
}

/**
 * Streams `window` of `path`, honouring a Range request inside it.
 *
 * The window is what makes one function serve both routes: a whole file is the
 * window `0..size-1`, and one entry of a bundle is the window it occupies in the
 * archive. A range from the client is relative to the window, never to the file,
 * so an entry can be seeked without the caller knowing where the archive holds it.
 *
 * Returns `null` when it has already answered — a 416, which has no body.
 */
export function serveRange(res: Response, options: ServeOptions): StreamableFile | null {
  const { path, window, contentType, disposition, etag, range } = options;
  const size = window.length;

  const wanted = parseRange(range, size);
  if (wanted === 'unsatisfiable') {
    res.status(416).set({ 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', ETag: etag });
    return null;
  }

  const start = window.start + (wanted?.start ?? 0);
  const end = window.start + (wanted?.end ?? size - 1);
  const length = end - start + 1;

  res.set({
    'Content-Type': contentType,
    'Content-Disposition': disposition,
    // Without this the browser cannot tell a finished download from a
    // truncated one, and shows no progress for either.
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Cache-Control': 'private, max-age=3600, must-revalidate',
  });

  if (wanted) {
    res.status(206).set({ 'Content-Range': `bytes ${wanted.start}-${wanted.end}/${size}` });
  }

  // An empty file has no byte to read, and no range over it is legal: node
  // rejects `end: -1` outright ("end must be >= start"), which reached the page
  // as a 500 on any zero-length entry in a bundle. Nothing to read is answered
  // with nothing, which is what Content-Length: 0 already promised.
  return new StreamableFile(length === 0 ? Readable.from([]) : createReadStream(path, { start, end }));
}
