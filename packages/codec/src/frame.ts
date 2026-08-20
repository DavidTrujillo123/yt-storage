import {
  HEADER_BYTES,
  HEIGHT,
  MAGIC,
  WIDTH,
  borderIsWhite,
} from './geometry.ts';
import type { Layout } from './layout.ts';
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

/**
 * Byte -> its eight bits, most significant first. One 2KB table instead of an
 * eight-iteration shift loop per byte: rendering a frame unpacks tens of
 * thousands of bytes and this is the inner loop of every encode.
 */
const BIT_TABLE = (() => {
  const table = new Uint8Array(256 * 8);
  for (let byte = 0; byte < 256; byte++) {
    for (let b = 0; b < 8; b++) table[byte * 8 + b] = (byte >> (7 - b)) & 1;
  }
  return table;
})();

/**
 * Scratch buffers, one set per layout.
 *
 * Kept rather than allocated per frame: a decode walks tens of thousands of
 * frames, and the bit plane alone is half a megabyte at the dense layout. None
 * of these ever leaves the function that fills it.
 */
interface Scratch {
  bits: Uint8Array;
  cells: Float32Array;
  bytes: Uint8Array;
}

const scratches = new Map<string, Scratch>();

function scratchFor(layout: Layout): Scratch {
  let scratch = scratches.get(layout.id);
  if (!scratch) {
    scratch = {
      bits: new Uint8Array(layout.innerBits),
      cells: new Float32Array(layout.gridW * layout.gridH),
      bytes: new Uint8Array(HEADER_BYTES + layout.shardBytes),
    };
    scratches.set(layout.id, scratch);
  }
  return scratch;
}

/** Renders one frame's bits into the layout's canvas as a grayscale buffer. */
export function renderFrame(header: Uint8Array, payload: Uint8Array, layout: Layout): Buffer {
  const { bits } = scratchFor(layout);
  const { block, gridW, gridH, innerW, canvasW, canvasH } = layout;

  let bit = 0;
  const write = (src: Uint8Array) => {
    for (let i = 0; i < src.length; i++) {
      const base = src[i] * 8;
      bits[bit] = BIT_TABLE[base];
      bits[bit + 1] = BIT_TABLE[base + 1];
      bits[bit + 2] = BIT_TABLE[base + 2];
      bits[bit + 3] = BIT_TABLE[base + 3];
      bits[bit + 4] = BIT_TABLE[base + 4];
      bits[bit + 5] = BIT_TABLE[base + 5];
      bits[bit + 6] = BIT_TABLE[base + 6];
      bits[bit + 7] = BIT_TABLE[base + 7];
      bit += 8;
    }
  };
  write(header);
  write(payload);
  // A shard shorter than the frame leaves the tail of a reused buffer holding
  // the previous frame's bits, which would render as data nobody wrote.
  bits.fill(0, bit);

  const img = Buffer.alloc(canvasW * canvasH);
  const row = Buffer.alloc(canvasW);

  for (let r = 0; r < gridH; r++) {
    const onEdgeRow = r === 0 || r === gridH - 1;
    const inner = (r - 1) * innerW - 1;
    for (let c = 0; c < gridW; c++) {
      const onBorder = onEdgeRow || c === 0 || c === gridW - 1;
      const value = onBorder ? (borderIsWhite(r, c) ? 255 : 0) : bits[inner + c] ? 255 : 0;
      // Written byte by byte rather than with fill(): the span is one block
      // wide, and the call overhead dominates something that short.
      const x = c * block;
      for (let k = 0; k < block; k++) row[x + k] = value;
    }
    for (let b = 0; b < block; b++) row.copy(img, (r * block + b) * canvasW);
  }
  return img;
}

export interface SampledFrame {
  /** One entry per inner block, 0 or 1. */
  bits: Uint8Array;
  /** Distance of each sample from the decision threshold. Low = unreliable. */
  confidence: Float32Array;
}

/** The sample points of every block, as flat pixel indices. */
const TAPS = 9;

/**
 * The same, for a block with no room to spread them.
 *
 * When `spread()` returns zero on both axes every one of the nine taps rounds
 * to the same pixel, so the wide table holds nine copies of one index and the
 * average is that pixel's own value. Storing it once is nine times less table
 * to stream past the cache — 2 MiB rather than 18.7 MiB a frame on the dense
 * grid — for exactly the same answer.
 */
const SINGLE_TAP = 1;

/**
 * Where to read each block, for one frame size and layout, and how many reads
 * a block takes.
 *
 * The taps of a block depend only on the resolution, and a video hands back
 * thousands of frames at the same one — so they are computed once and kept.
 * Doing it per frame meant a million rounds of float arithmetic, Math.round
 * and two clamps per frame, which measured as three quarters of the whole
 * decode.
 */
let tapCache: { key: string; offsets: Int32Array; taps: number } | null = null;

/**
 * How far from a block's centre the outer taps sit, along one axis.
 *
 * A fifth of the block keeps the taps away from the edges, where DCT ringing
 * lives — but only while there is room for them. A block two pixels wide has
 * none: its centre falls between pixels, and an offset of one lands in the
 * neighbour, sampling somebody else's bit. That is not a near miss but a
 * wrong answer, so the taps collapse onto the centre instead.
 */
function spread(size: number): number {
  const want = Math.max(1, Math.floor(size / 5));
  const room = Math.floor((size - 1) / 2);
  return Math.min(want, room);
}

function tapsFor(width: number, height: number, layout: Layout): { offsets: Int32Array; taps: number } {
  const key = `${layout.id}:${width}x${height}`;
  if (tapCache && tapCache.key === key) return tapCache;

  const { gridW, gridH } = layout;
  const bw = width / gridW;
  const bh = height / gridH;
  const dy = spread(bh);
  const dx = spread(bw);
  const taps = dx === 0 && dy === 0 ? SINGLE_TAP : TAPS;

  const offsets = new Int32Array(gridW * gridH * taps);
  let at = 0;
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      const y = (r + 0.5) * bh;
      const x = (c + 0.5) * bw;
      if (taps === SINGLE_TAP) {
        const py = Math.min(height - 1, Math.max(0, Math.round(y)));
        const px = Math.min(width - 1, Math.max(0, Math.round(x)));
        offsets[at++] = py * width + px;
        continue;
      }
      for (const oy of [-dy, 0, dy]) {
        for (const ox of [-dx, 0, dx]) {
          const py = Math.min(height - 1, Math.max(0, Math.round(y + oy)));
          const px = Math.min(width - 1, Math.max(0, Math.round(x + ox)));
          offsets[at++] = py * width + px;
        }
      }
    }
  }

  tapCache = { key, offsets, taps };
  return tapCache;
}

/**
 * Reads block values back out of a decoded frame at whatever resolution
 * YouTube handed back. Samples the centre of each block only — block edges are
 * where DCT ringing lives.
 */
export function sampleFrame(
  img: Uint8Array,
  width: number,
  height: number,
  layout: Layout,
): SampledFrame {
  const { offsets, taps } = tapsFor(width, height, layout);
  const { cells } = scratchFor(layout);
  const { gridW, gridH, innerW, innerH, innerBits } = layout;

  if (taps === SINGLE_TAP) {
    for (let i = 0; i < cells.length; i++) cells[i] = img[offsets[i]];
  } else {
    for (let i = 0, at = 0; i < cells.length; i++, at += TAPS) {
      const sum =
        img[offsets[at]] +
        img[offsets[at + 1]] +
        img[offsets[at + 2]] +
        img[offsets[at + 3]] +
        img[offsets[at + 4]] +
        img[offsets[at + 5]] +
        img[offsets[at + 6]] +
        img[offsets[at + 7]] +
        img[offsets[at + 8]];
      cells[i] = sum / TAPS;
    }
  }

  // Recover reference levels from the checkerboard border.
  let whiteSum = 0;
  let whiteN = 0;
  let blackSum = 0;
  let blackN = 0;
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      if (r !== 0 && c !== 0 && r !== gridH - 1 && c !== gridW - 1) continue;
      const v = cells[r * gridW + c];
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

  const bits = new Uint8Array(innerBits);
  const confidence = new Float32Array(innerBits);
  for (let r = 0; r < innerH; r++) {
    const src = (r + 1) * gridW + 1;
    const dst = r * innerW;
    for (let c = 0; c < innerW; c++) {
      const v = cells[src + c];
      bits[dst + c] = v >= threshold ? 1 : 0;
      confidence[dst + c] = v >= threshold ? v - threshold : threshold - v;
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

function tryParse(bits: Uint8Array, layout: Layout): DecodedFrame | null {
  const total = HEADER_BYTES + layout.shardBytes;
  const scratch = scratchFor(layout).bytes;
  bitsToBytes(bits, total, scratch);

  const buf = Buffer.from(scratch.buffer, scratch.byteOffset, total);
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

/** How many of the least confident bits the repair pass may flip, and in pairs. */
const REPAIR_CANDIDATES = 20;
const REPAIR_PAIR_POOL = 12;

/**
 * The `count` least confident bit positions, lowest first.
 *
 * Kept as a selection rather than a sort. The full order was never needed —
 * only the first twenty — and sorting meant building and sorting an array of
 * every bit in the frame for every frame that fails its CRC, which is exactly
 * the frames a damaged download is full of.
 */
function leastConfident(confidence: Float32Array, over: number, count: number): Int32Array {
  const best = new Int32Array(count);
  const values = new Float32Array(count);
  let filled = 0;
  let worst = Infinity;

  for (let i = 0; i < over; i++) {
    const v = confidence[i];
    if (filled === count && v >= worst) continue;

    // Insertion into a list this short beats a heap, and `>` rather than `>=`
    // keeps ties in index order, which is what sorting used to give.
    let at = filled < count ? filled : count - 1;
    while (at > 0 && values[at - 1] > v) {
      values[at] = values[at - 1];
      best[at] = best[at - 1];
      at--;
    }
    values[at] = v;
    best[at] = i;
    if (filled < count) filled++;
    worst = filled === count ? values[count - 1] : Infinity;
  }

  return filled === count ? best : best.subarray(0, filled);
}

/**
 * Turns sampled blocks back into a shard.
 *
 * A frame that fails its CRC is not immediately discarded: the sampler reports
 * how far each block sat from the threshold, so the least confident bits are
 * the likely errors. Flipping one or two of them and retesting the CRC repairs
 * most marginal frames, which keeps them out of the erasure budget.
 */
export function decodeFrame(
  sampled: SampledFrame,
  layout: Layout,
  softRepair = true,
): DecodedFrame | null {
  const direct = tryParse(sampled.bits, layout);
  if (direct) return direct;
  if (!softRepair) return null;

  const usedBits = (HEADER_BYTES + layout.shardBytes) * 8;
  const order = leastConfident(sampled.confidence, usedBits, REPAIR_CANDIDATES);

  const bits = sampled.bits.slice();

  for (const i of order) {
    bits[i] ^= 1;
    const hit = tryParse(bits, layout);
    if (hit) return { ...hit, repairedBits: 1 };
    bits[i] ^= 1;
  }

  const pairPool = order.subarray(0, REPAIR_PAIR_POOL);
  for (let a = 0; a < pairPool.length; a++) {
    for (let b = a + 1; b < pairPool.length; b++) {
      bits[pairPool[a]] ^= 1;
      bits[pairPool[b]] ^= 1;
      const hit = tryParse(bits, layout);
      if (hit) return { ...hit, repairedBits: 2 };
      bits[pairPool[a]] ^= 1;
      bits[pairPool[b]] ^= 1;
    }
  }
  return null;
}
