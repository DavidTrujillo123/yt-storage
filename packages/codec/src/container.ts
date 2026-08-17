import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, gzipSync, gunzipSync } from 'node:zlib';

const FILE_MAGIC = Buffer.from('ISGF');
const VERSION = 1;
const FLAG_GZIP = 1;

export interface ContainerMeta {
  name: string;
  originalSize: number;
  sha256: string;
  gzipped: boolean;
}

/**
 * Wraps a file into the byte stream that gets sharded across frames.
 *
 * Header (big endian):
 *   magic(4) version(1) flags(1) payloadLength(8) sha256(32) nameLength(2) name(n)
 */
/**
 * How much of a large file is compressed to find out whether the rest is worth
 * compressing, and the ratio below which it is.
 *
 * Compressing to decide used to mean compressing all of it: a 400MB video —
 * already compressed, so the answer is always no — spent six seconds and held
 * a second copy of itself to learn that. A slice answers the same question,
 * and being wrong only costs ratio, never correctness.
 */
const GZIP_SAMPLE_BYTES = 4 * 1024 * 1024;
const GZIP_WORTH_IT = 0.98;

/** Builds the fixed part of the stream: everything before the payload. */
function buildHeader(name: string, sha256: Buffer, payloadLength: number, gzipped: boolean): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(48 + nameBuf.length);
  FILE_MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(gzipped ? FLAG_GZIP : 0, 5);
  header.writeBigUInt64BE(BigInt(payloadLength), 6);
  sha256.copy(header, 14);
  header.writeUInt16BE(nameBuf.length, 46);
  nameBuf.copy(header, 48);
  return header;
}

/**
 * The same stream as `pack`, for a file too big to hold.
 *
 * `pack` builds the whole thing in memory, which meant an encode kept three
 * copies of the input alive at once — the file, the concatenated stream, and
 * the padded group buffer. Measured at 5.6 GiB of resident memory for a
 * 600 MB upload, which is where the app's two-gigabyte upload ceiling came
 * from.
 *
 * Here the header is the only thing held. The payload stays on disk — the
 * input file itself when gzip does not pay off, which for the media and
 * archives this stores is nearly always, and a temporary file when it does.
 */
export interface StreamSource {
  /** The bytes before the payload. Always smaller than one group. */
  header: Buffer;
  payloadPath: string;
  payloadLength: number;
  meta: ContainerMeta;
  /** Removes the temporary file, when compressing made one. */
  close(): Promise<void>;
}

export async function openStream(
  path: string,
  name: string,
  scratchPath: string,
): Promise<StreamSource> {
  const { size } = await stat(path);

  // One pass for the hash, keeping the first few megabytes as they go by so
  // the compression question can be answered without a second read.
  const hash = createHash('sha256');
  const sample: Buffer[] = [];
  let sampled = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    if (sampled < GZIP_SAMPLE_BYTES) {
      const take = bytes.subarray(0, GZIP_SAMPLE_BYTES - sampled);
      sample.push(take);
      sampled += take.length;
    }
  }
  const sha256 = hash.digest();

  // Same rule as `pack`: a small file is compressed outright, a large one is
  // judged on its first four megabytes. Being wrong costs ratio, never
  // correctness.
  const head = Buffer.concat(sample, sampled);
  const worthTrying =
    size <= GZIP_SAMPLE_BYTES || gzipSync(head, { level: 6 }).length / head.length < GZIP_WORTH_IT;

  let payloadPath = path;
  let payloadLength = size;
  let gzipped = false;
  let temporary: string | null = null;

  if (worthTrying) {
    temporary = scratchPath;
    await pipeline(createReadStream(path), createGzip({ level: 6 }), createWriteStream(temporary));
    const compressed = (await stat(temporary)).size;
    // Compression that made the file bigger is compression that did not
    // happen — already-compressed input grows slightly under gzip, and every
    // wasted byte is video.
    if (compressed < size) {
      payloadPath = temporary;
      payloadLength = compressed;
      gzipped = true;
    } else {
      await rm(temporary, { force: true });
      temporary = null;
    }
  }

  return {
    header: buildHeader(name, sha256, payloadLength, gzipped),
    payloadPath,
    payloadLength,
    meta: { name, originalSize: size, sha256: sha256.toString('hex'), gzipped },
    close: async () => {
      if (temporary) await rm(temporary, { force: true });
    },
  };
}

/**
 * A positioned reader over `header ++ payload`, without either being one
 * buffer.
 *
 * The encoder walks the stream a group at a time and the header is only ever
 * at the front of the first one, so this is the whole of the joining.
 */
export async function openStreamReader(source: StreamSource) {
  const handle = await open(source.payloadPath, 'r');
  const headerLength = source.header.length;

  return {
    /**
     * Fills `dest[0..length)` with the stream from `offset`, zero-padding
     * whatever is past the end — which is exactly what a final short group
     * needs.
     */
    async read(dest: Buffer, offset: number, length: number): Promise<void> {
      let filled = 0;
      if (offset < headerLength) {
        filled = Math.min(headerLength - offset, length);
        source.header.copy(dest, 0, offset, offset + filled);
      }

      // Where the payload picks up: the start of it when the header was in
      // the way, and the matching offset into it otherwise.
      let at = Math.max(0, offset - headerLength);
      while (filled < length) {
        const { bytesRead } = await handle.read(dest, filled, length - filled, at);
        if (bytesRead === 0) break;
        filled += bytesRead;
        at += bytesRead;
      }

      dest.fill(0, filled, length);
    },
    close: () => handle.close(),
  };
}

/**
 * The other end of `openStream`: a container written a piece at a time.
 *
 * `unpack` needs the whole stream in a buffer, then gunzips it into a second
 * one, then hashes that — three copies of the file for a decode that already
 * held every recovered shard. Here the stream is fed in as the groups come out
 * of the video, and what is live is a chunk.
 *
 * The file lands under a `.part` name and is renamed only once the hash
 * matches, so the rule that a decode never hands back bytes it has not
 * verified survives the change. It is the same trick the restore path already
 * plays with its scratch directories.
 */
export interface ContainerWriter {
  /** Feeds the next bytes of the stream. Padding past the payload is ignored. */
  write(chunk: Buffer): Promise<void>;
  /** Closes, verifies the hash, and puts the file under its real name. */
  finish(): Promise<{ path: string; bytes: number; meta: ContainerMeta }>;
  /** Gives up and leaves nothing behind. */
  abort(): Promise<void>;
}

export function openContainerWriter(outputDir: string): ContainerWriter {
  let header: ContainerHeader | null = null;
  let head: Buffer = Buffer.alloc(0);

  let source: PassThrough | null = null;
  let running: Promise<void> | null = null;
  let hash: Hash | null = null;
  let written = 0;
  let payloadLeft = 0;
  let tmpPath = '';
  let outPath = '';

  /** Opens the output once the header says what to call it and how to read it. */
  const begin = (): void => {
    const meta = header!;
    outPath = join(outputDir, meta.name);
    tmpPath = `${outPath}.part`;

    hash = createHash('sha256');
    // The hash and the byte count are of the *file*, not the payload, so they
    // sit after the gunzip rather than before it.
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash!.update(chunk);
        written += chunk.length;
        callback(null, chunk);
      },
    });

    const input = new PassThrough();
    const out = createWriteStream(tmpPath);
    const chain = meta.gzipped
      ? pipeline(input, createGunzip(), counted, out)
      : pipeline(input, counted, out);
    // Failures surface from `finish`, which awaits this; without a handler
    // here a broken gzip stream is an unhandled rejection first.
    chain.catch(() => undefined);

    source = input;
    running = chain;
    payloadLeft = meta.payloadLength;
  };

  const feed = async (chunk: Buffer): Promise<void> => {
    if (payloadLeft <= 0 || chunk.length === 0) return;
    const take = chunk.length <= payloadLeft ? chunk : chunk.subarray(0, payloadLeft);
    payloadLeft -= take.length;
    if (!source!.write(take)) await once(source!, 'drain');
  };

  return {
    async write(chunk) {
      if (header) return feed(chunk);

      // The header is 48 bytes plus a name, so this collects at most a few
      // hundred before the real writing starts.
      head = head.length === 0 ? Buffer.from(chunk) : Buffer.concat([head, chunk]);
      if (head.length < 48) return;
      const nameLength = head.readUInt16BE(46);
      if (head.length < 48 + nameLength) return;

      header = readHeader(head);
      begin();
      await feed(head.subarray(header.payloadOffset));
      head = Buffer.alloc(0);
    },

    async finish() {
      if (!header) throw new Error('no container header in the decoded stream');
      source!.end();
      await running;

      if (payloadLeft > 0) {
        await rm(tmpPath, { force: true });
        throw new Error(`truncated stream: ${payloadLeft} bytes short of ${header.payloadLength}`);
      }

      const actual = hash!.digest('hex');
      if (actual !== header.sha256) {
        await rm(tmpPath, { force: true });
        throw new Error(`sha256 mismatch: expected ${header.sha256}, got ${actual}`);
      }

      await rename(tmpPath, outPath);
      return {
        path: outPath,
        bytes: written,
        meta: {
          name: header.name,
          originalSize: written,
          sha256: actual,
          gzipped: header.gzipped,
        },
      };
    },

    async abort() {
      source?.destroy();
      await running?.catch(() => undefined);
      if (tmpPath) await rm(tmpPath, { force: true });
    },
  };
}

export function pack(name: string, data: Buffer): { stream: Buffer; meta: ContainerMeta } {
  const sha256 = createHash('sha256').update(data).digest();

  // Skip compression when it does not help — already-compressed input (zip,
  // jpeg, mp4) grows slightly under gzip, and every wasted byte is video.
  let compressed: Buffer | null = null;
  if (data.length <= GZIP_SAMPLE_BYTES) {
    compressed = gzipSync(data, { level: 6 });
  } else {
    const sample = data.subarray(0, GZIP_SAMPLE_BYTES);
    const ratio = gzipSync(sample, { level: 6 }).length / sample.length;
    if (ratio < GZIP_WORTH_IT) compressed = gzipSync(data, { level: 6 });
  }

  const gzipped = compressed !== null && compressed.length < data.length;
  const payload = gzipped ? compressed! : data;

  return {
    stream: Buffer.concat([buildHeader(name, sha256, payload.length, gzipped), payload]),
    meta: { name, originalSize: data.length, sha256: sha256.toString('hex'), gzipped },
  };
}

export interface ContainerHeader {
  name: string;
  payloadLength: number;
  sha256: string;
  gzipped: boolean;
  /** Stream bytes before the payload starts. */
  payloadOffset: number;
}

/**
 * The header alone, from however much of the stream is to hand.
 *
 * Split out from `unpack` because a partial read has to answer three questions
 * before it knows whether it can go on at all — where the payload starts, how
 * long it is, and whether it is gzipped, which no reader can start from the
 * middle of. The header is 48 bytes plus a name, so it always lands inside the
 * first group.
 */
export function readHeader(stream: Buffer): ContainerHeader {
  if (stream.length < 48) throw new Error(`container header needs 48 bytes, got ${stream.length}`);
  if (!stream.subarray(0, 4).equals(FILE_MAGIC)) throw new Error('bad container magic');
  const version = stream.readUInt8(4);
  if (version !== VERSION) throw new Error(`unsupported container version ${version}`);

  const flags = stream.readUInt8(5);
  const nameLength = stream.readUInt16BE(46);
  if (stream.length < 48 + nameLength) {
    throw new Error(`container name needs ${nameLength} bytes, got ${stream.length - 48}`);
  }

  return {
    name: stream.subarray(48, 48 + nameLength).toString('utf8'),
    payloadLength: Number(stream.readBigUInt64BE(6)),
    sha256: stream.subarray(14, 46).toString('hex'),
    gzipped: (flags & FLAG_GZIP) !== 0,
    payloadOffset: 48 + nameLength,
  };
}

export function unpack(stream: Buffer): { data: Buffer; meta: ContainerMeta } {
  const { name, payloadLength, sha256, gzipped, payloadOffset } = readHeader(stream);

  const payload = stream.subarray(payloadOffset, payloadOffset + payloadLength);
  if (payload.length !== payloadLength) {
    throw new Error(`truncated stream: got ${payload.length} of ${payloadLength} bytes`);
  }

  const data = gzipped ? gunzipSync(payload) : Buffer.from(payload);

  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== sha256) throw new Error(`sha256 mismatch: expected ${sha256}, got ${actual}`);

  return { data, meta: { name, originalSize: data.length, sha256, gzipped } };
}
