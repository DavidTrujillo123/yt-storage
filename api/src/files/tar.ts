import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/**
 * A ustar writer and reader, in about a hundred lines and no dependency.
 *
 * Uploading costs 1,600 quota units per video regardless of size, so six
 * uploads a day is the whole budget — a folder of fifty photos sent one file
 * at a time is not slow, it is impossible. Bundling them into one archive
 * makes it one upload, and tar is the format that does that without
 * re-compressing already-compressed bytes.
 *
 * ustar rather than a zip because tar is a sequence of 512-byte headers each
 * followed by its file: it can be written straight to disk in one pass, and a
 * listing is a walk of the headers with the data skipped by seeking.
 */
const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

export interface TarSource {
  /** Path inside the archive, e.g. holiday/beach.jpg */
  name: string;
  /** Where the bytes are right now. */
  path: string;
  size: number;
}

export interface TarItem {
  name: string;
  size: number;
  /** Byte offset of the entry's data within the archive. */
  offset: number;
}

/**
 * Makes a browser-supplied path safe to store.
 *
 * Names arrive from `webkitRelativePath`, which is client-controlled, and this
 * one goes into an archive somebody will eventually extract. Absolute paths and
 * `..` segments are how an extraction escapes the directory it was aimed at.
 */
export function safeEntryName(raw: string, fallback: string): string {
  const cleaned = raw
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/')
    .replace(/^\/+/, '');
  return cleaned === '' ? fallback : cleaned;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(entry: TarSource, mtime: Date): Buffer {
  const block = Buffer.alloc(BLOCK);

  // Anything over 100 characters is split across the prefix field; there is no
  // GNU long-name support here, so a genuinely enormous path is refused rather
  // than silently truncated into a different file.
  let name = entry.name;
  let prefix = '';
  if (Buffer.byteLength(name) > NAME_MAX) {
    const cut = name.lastIndexOf('/', PREFIX_MAX);
    if (cut > 0) {
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    if (Buffer.byteLength(name) > NAME_MAX || Buffer.byteLength(prefix) > PREFIX_MAX) {
      throw new Error(`path too long for a tar entry: ${entry.name}`);
    }
  }

  block.write(name, 0, NAME_MAX, 'utf8');
  block.write(octal(0o644, 8), 100, 8, 'ascii'); // mode
  block.write(octal(0, 8), 108, 8, 'ascii'); // uid
  block.write(octal(0, 8), 116, 8, 'ascii'); // gid
  block.write(octal(entry.size, 12), 124, 12, 'ascii');
  block.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii'); // checksum placeholder: spaces
  block.write('0', 156, 1, 'ascii'); // typeflag: regular file
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, PREFIX_MAX, 'utf8');

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return block;
}

/** Writes the entries to `outPath` in order, returning the archive size. */
export async function writeTar(entries: TarSource[], outPath: string): Promise<number> {
  const out = createWriteStream(outPath);

  // `pipeline` attaches its own error/close/finish/end handlers to this stream
  // on every entry, and they are only removed when it ends. Five hundred
  // entries means five hundred sets, which trips Node's leak warning at ten
  // and is genuine waste. The limit is per stream, and this one is ours.
  out.setMaxListeners(0);

  const mtime = new Date();
  let written = 0;

  const put = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      written += chunk.length;
      out.write(chunk, (error) => (error ? reject(error) : resolve()));
    });

  try {
    for (const entry of entries) {
      await put(header(entry, mtime));
      await pipeline(createReadStream(entry.path), out, { end: false });
      written += entry.size;

      // Every file is padded out to a whole block.
      const remainder = entry.size % BLOCK;
      if (remainder !== 0) await put(Buffer.alloc(BLOCK - remainder));
    }
    // Two zero blocks mark the end of the archive.
    await put(Buffer.alloc(BLOCK * 2));
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }

  return written;
}

/**
 * Walks the headers and skips the data, so listing a 10 GiB archive reads a few
 * kilobytes rather than all of it.
 */
export async function listTar(path: string, limit = 10_000): Promise<TarItem[]> {
  const { size: total } = await stat(path);
  const handle = await open(path, 'r');
  const block = Buffer.alloc(BLOCK);
  const items: TarItem[] = [];

  try {
    let offset = 0;
    while (offset + BLOCK <= total && items.length < limit) {
      const { bytesRead } = await handle.read(block, 0, BLOCK, offset);
      if (bytesRead < BLOCK) break;

      // A zero block is the end of the archive.
      if (block[0] === 0) break;
      if (block.toString('ascii', 257, 262) !== 'ustar') {
        throw new Error('not a tar archive');
      }

      const name = block.toString('utf8', 0, NAME_MAX).replace(/\0.*$/, '');
      const prefix = block.toString('utf8', 345, 345 + PREFIX_MAX).replace(/\0.*$/, '');
      const size = parseInt(block.toString('ascii', 124, 136).replace(/[\0 ]/g, ''), 8) || 0;
      const type = block.toString('ascii', 156, 157);

      offset += BLOCK;
      if (type === '0' || type === '\0') {
        items.push({ name: prefix ? `${prefix}/${name}` : name, size, offset });
      }
      offset += Math.ceil(size / BLOCK) * BLOCK;
    }
  } finally {
    await handle.close();
  }

  return items;
}

export function isTarName(name: string): boolean {
  return name.toLowerCase().endsWith('.tar');
}
