import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

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
export function pack(name: string, data: Buffer): { stream: Buffer; meta: ContainerMeta } {
  const sha256 = createHash('sha256').update(data).digest();

  // Skip compression when it does not help — already-compressed input (zip,
  // jpeg, mp4) grows slightly under gzip, and every wasted byte is video.
  const compressed = gzipSync(data, { level: 6 });
  const gzipped = compressed.length < data.length;
  const payload = gzipped ? compressed : data;

  const nameBuf = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(48 + nameBuf.length);
  FILE_MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(gzipped ? FLAG_GZIP : 0, 5);
  header.writeBigUInt64BE(BigInt(payload.length), 6);
  sha256.copy(header, 14);
  header.writeUInt16BE(nameBuf.length, 46);
  nameBuf.copy(header, 48);

  return {
    stream: Buffer.concat([header, payload]),
    meta: { name, originalSize: data.length, sha256: sha256.toString('hex'), gzipped },
  };
}

export function unpack(stream: Buffer): { data: Buffer; meta: ContainerMeta } {
  if (!stream.subarray(0, 4).equals(FILE_MAGIC)) throw new Error('bad container magic');
  const version = stream.readUInt8(4);
  if (version !== VERSION) throw new Error(`unsupported container version ${version}`);

  const flags = stream.readUInt8(5);
  const payloadLength = Number(stream.readBigUInt64BE(6));
  const sha256 = stream.subarray(14, 46).toString('hex');
  const nameLength = stream.readUInt16BE(46);
  const name = stream.subarray(48, 48 + nameLength).toString('utf8');

  const start = 48 + nameLength;
  const payload = stream.subarray(start, start + payloadLength);
  if (payload.length !== payloadLength) {
    throw new Error(`truncated stream: got ${payload.length} of ${payloadLength} bytes`);
  }

  const gzipped = (flags & FLAG_GZIP) !== 0;
  const data = gzipped ? gunzipSync(payload) : Buffer.from(payload);

  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== sha256) throw new Error(`sha256 mismatch: expected ${sha256}, got ${actual}`);

  return { data, meta: { name, originalSize: data.length, sha256, gzipped } };
}
