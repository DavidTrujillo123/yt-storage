import {
  BLOCK,
  GRID_H,
  GRID_W,
  HEADER_BYTES,
  HEIGHT,
  INNER_BITS,
  INNER_H,
  INNER_W,
  MAGIC,
  SHARD_BYTES,
  WIDTH,
  borderIsWhite,
} from './geometry.ts';
import { crc32 } from './crc32.ts';

export interface FrameHeader {
  groupIndex: number;
  shardIndex: number;
  flags: number;
}

/**
 * Header layout (16 bytes, big endian):
 *   0..3   magic
 *   4..7   group index
 *   8      shard index (0..29; >= RS_K means a parity shard)
 *   9      flags
 *   10..11 reserved
 *   12..15 crc32 over header[0..11] + payload
 */
export function buildHeader(h: FrameHeader, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(MAGIC, 0);
  header.writeUInt32BE(h.groupIndex, 4);
  header.writeUInt8(h.shardIndex, 8);
  header.writeUInt8(h.flags, 9);

  const check = Buffer.concat([header.subarray(0, 12), payload]);
  header.writeUInt32BE(crc32(check), 12);
  return header;
}

/** Renders one frame's bits into a WIDTH x HEIGHT grayscale buffer. */
export function renderFrame(header: Uint8Array, payload: Uint8Array): Buffer {
  const bits = new Uint8Array(INNER_BITS);
  let bit = 0;
  const write = (src: Uint8Array) => {
    for (let i = 0; i < src.length; i++) {
      const byte = src[i];
      for (let b = 7; b >= 0; b--) bits[bit++] = (byte >> b) & 1;
    }
  };
  write(header);
  write(payload);

  const img = Buffer.alloc(WIDTH * HEIGHT);
  const row = Buffer.alloc(WIDTH);

  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const onBorder = r === 0 || c === 0 || r === GRID_H - 1 || c === GRID_W - 1;
      let value: number;
      if (onBorder) {
        value = borderIsWhite(r, c) ? 255 : 0;
      } else {
        value = bits[(r - 1) * INNER_W + (c - 1)] ? 255 : 0;
      }
      row.fill(value, c * BLOCK, (c + 1) * BLOCK);
    }
    for (let b = 0; b < BLOCK; b++) row.copy(img, (r * BLOCK + b) * WIDTH);
  }
  return img;
}

export interface SampledFrame {
  /** One entry per inner block, 0 or 1. */
  bits: Uint8Array;
  /** Distance of each sample from the decision threshold. Low = unreliable. */
  confidence: Float32Array;
}

/**
 * Reads block values back out of a decoded frame at whatever resolution
 * YouTube handed back. Samples the centre of each block only — block edges are
 * where DCT ringing lives.
 */
export function sampleFrame(img: Uint8Array, width: number, height: number): SampledFrame {
  const bw = width / GRID_W;
  const bh = height / GRID_H;

  const centre = (r: number, c: number): number => {
    const y = (r + 0.5) * bh;
    const x = (c + 0.5) * bw;
    const dy = Math.max(1, Math.floor(bh / 5));
    const dx = Math.max(1, Math.floor(bw / 5));
    let sum = 0;
    let n = 0;
    for (const oy of [-dy, 0, dy]) {
      for (const ox of [-dx, 0, dx]) {
        const py = Math.min(height - 1, Math.max(0, Math.round(y + oy)));
        const px = Math.min(width - 1, Math.max(0, Math.round(x + ox)));
        sum += img[py * width + px];
        n++;
      }
    }
    return sum / n;
  };

  // Recover reference levels from the checkerboard border.
  let whiteSum = 0;
  let whiteN = 0;
  let blackSum = 0;
  let blackN = 0;
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (r !== 0 && c !== 0 && r !== GRID_H - 1 && c !== GRID_W - 1) continue;
      const v = centre(r, c);
      if (borderIsWhite(r, c)) {
        whiteSum += v;
        whiteN++;
      } else {
        blackSum += v;
        blackN++;
      }
    }
  }
  const white = whiteN ? whiteSum / whiteN : 255;
  const black = blackN ? blackSum / blackN : 0;
  const threshold = (white + black) / 2;

  const bits = new Uint8Array(INNER_BITS);
  const confidence = new Float32Array(INNER_BITS);
  for (let r = 0; r < INNER_H; r++) {
    for (let c = 0; c < INNER_W; c++) {
      const v = centre(r + 1, c + 1);
      const i = r * INNER_W + c;
      bits[i] = v >= threshold ? 1 : 0;
      confidence[i] = Math.abs(v - threshold);
    }
  }
  return { bits, confidence };
}

function bitsToBytes(bits: Uint8Array, count: number, out: Uint8Array): void {
  for (let i = 0; i < count; i++) {
    let byte = 0;
    const base = i * 8;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[base + b];
    out[i] = byte;
  }
}

export interface DecodedFrame {
  header: FrameHeader;
  payload: Buffer;
  /** Number of bits the soft-decision pass had to flip to satisfy the CRC. */
  repairedBits: number;
}

const TOTAL_BYTES = HEADER_BYTES + SHARD_BYTES;

function tryParse(bits: Uint8Array, scratch: Uint8Array): DecodedFrame | null {
  bitsToBytes(bits, TOTAL_BYTES, scratch);
  const buf = Buffer.from(scratch.buffer, scratch.byteOffset, TOTAL_BYTES);
  if (buf.readUInt32BE(0) !== MAGIC) return null;

  const expected = buf.readUInt32BE(12);
  const check = Buffer.concat([buf.subarray(0, 12), buf.subarray(HEADER_BYTES)]);
  if (crc32(check) !== expected) return null;

  return {
    header: {
      groupIndex: buf.readUInt32BE(4),
      shardIndex: buf.readUInt8(8),
      flags: buf.readUInt8(9),
    },
    payload: Buffer.from(buf.subarray(HEADER_BYTES)),
    repairedBits: 0,
  };
}

/**
 * Turns sampled blocks back into a shard.
 *
 * A frame that fails its CRC is not immediately discarded: the sampler reports
 * how far each block sat from the threshold, so the least confident bits are
 * the likely errors. Flipping one or two of them and retesting the CRC repairs
 * most marginal frames, which keeps them out of the erasure budget.
 */
export function decodeFrame(sampled: SampledFrame, softRepair = true): DecodedFrame | null {
  const scratch = new Uint8Array(TOTAL_BYTES);
  const direct = tryParse(sampled.bits, scratch);
  if (direct) return direct;
  if (!softRepair) return null;

  const usedBits = TOTAL_BYTES * 8;
  const order = Array.from({ length: usedBits }, (_, i) => i).sort(
    (a, b) => sampled.confidence[a] - sampled.confidence[b],
  );

  const bits = sampled.bits.slice();
  const candidates = order.slice(0, 20);

  for (const i of candidates) {
    bits[i] ^= 1;
    const hit = tryParse(bits, scratch);
    if (hit) return { ...hit, repairedBits: 1 };
    bits[i] ^= 1;
  }

  const pairPool = order.slice(0, 12);
  for (let a = 0; a < pairPool.length; a++) {
    for (let b = a + 1; b < pairPool.length; b++) {
      bits[pairPool[a]] ^= 1;
      bits[pairPool[b]] ^= 1;
      const hit = tryParse(bits, scratch);
      if (hit) return { ...hit, repairedBits: 2 };
      bits[pairPool[a]] ^= 1;
      bits[pairPool[b]] ^= 1;
    }
  }
  return null;
}
