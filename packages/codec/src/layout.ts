/**
 * How many bytes a frame carries, and what that costs.
 *
 * Everything here follows from one number: how many pixels wide a bit is drawn.
 * A smaller block fits more bits on the same 1080p canvas — four times as many
 * at 2 pixels as at 4 — which makes the video that many times shorter for the
 * same file, and the encode that many times cheaper, because it is frames that
 * cost and not seconds.
 *
 * What it spends is margin, and less of it than it looks. Both grids need the
 * same thing back from YouTube — a 1080p rendition — because what a block has
 * to survive is the re-encode, not the scaling: at 1080p a 2-pixel block is
 * two whole pixels of its own. Measured on a VP9 transcode at crf 36, harsher
 * than the crf 32 YouTube is estimated at: the dense grid recovers
 * byte-identical data at 1080p and fails at 972p, and the wide one recovers at
 * 900p and fails at 810p.
 *
 * Three-pixel blocks are missing on purpose. They upscale to 6-pixel squares,
 * which do not line up with the 8x8 grid x264 works in, and the master comes
 * out 33x the size of the file instead of 4.5x.
 */
import { HEADER_BITS, HEIGHT, RS_K, UPSCALE_H, UPSCALE_W, WIDTH } from './geometry.ts';

export type LayoutId = 'dense' | 'wide' | 'ultra';

export interface Layout {
  /** Stored per file, so a video written by an older version still reads. */
  id: LayoutId;
  block: number;
  /**
   * The canvas the encoder draws on, which is not always what is uploaded.
   *
   * `dense` and `wide` draw at 1920x1080 and are then doubled with nearest
   * neighbour, so every block arrives at YouTube as four pixels of margin
   * against the re-encode. `ultra` draws at 3840x2160 and spends that margin
   * on data instead: four times the bytes a second, and therefore a quarter of
   * the video to move and a quarter of the frames to decode.
   */
  canvasW: number;
  canvasH: number;
  /** What is handed to x264, after the nearest-neighbour upscale if there is one. */
  uploadW: number;
  uploadH: number;
  gridW: number;
  gridH: number;
  innerW: number;
  innerH: number;
  innerBits: number;
  /** Payload bytes per frame. */
  shardBytes: number;
  /** Payload bytes per Reed-Solomon group. */
  groupBytes: number;
  /** x264 quality for the master upload. */
  crf: string;
  /**
   * Served height below which this layout cannot be sampled at all. Measured
   * per grid rather than derived: what breaks is where block edges stop
   * landing on pixel edges, and that is not a clean function of block size.
   */
  minHeight: number;
  /**
   * Pixels a block covers at `minHeight`, and so the least detail the sampler
   * needs kept — the point past which ffmpeg may downscale on the way in.
   *
   * Derived from the measured height rather than stated again, because the two
   * cannot disagree: a grid readable at 1080p is a grid readable at
   * `1080 / gridH` pixels a block, whatever put those pixels there. Two, for
   * the dense grid, is not a typo — a 2-pixel block at 1080p is two whole
   * pixels of its own, and what a block has to survive is the re-encode rather
   * than the scaling.
   */
  pixelsPerBlock: number;
}

function layoutFor(
  id: LayoutId,
  block: number,
  crf: string,
  minHeight: number,
  canvas: { w: number; h: number } = { w: WIDTH, h: HEIGHT },
): Layout {
  const gridW = canvas.w / block;
  const gridH = canvas.h / block;
  const innerW = gridW - 2;
  const innerH = gridH - 2;
  const innerBits = innerW * innerH;
  // Floored to a multiple of 8 because @ronomon/reed-solomon requires shard
  // sizes divisible by 8.
  const shardBytes = Math.floor((innerBits - HEADER_BITS) / 8 / 8) * 8;

  return {
    id,
    block,
    canvasW: canvas.w,
    canvasH: canvas.h,
    // Upscaled to 4K unless the canvas is already there. Nearest neighbour, so
    // it adds no information — only room for YouTube's encoder to blur into.
    uploadW: UPSCALE_W,
    uploadH: UPSCALE_H,
    gridW,
    gridH,
    innerW,
    innerH,
    innerBits,
    shardBytes,
    groupBytes: RS_K * shardBytes,
    crf,
    minHeight,
    pixelsPerBlock: minHeight / gridH,
  };
}

/**
 * 2-pixel blocks: 64408 bytes a frame, 1.47 MiB of payload per second of video.
 *
 * Four times the wide grid, so a video a quarter as long and an encode a
 * quarter the frames — measured at 3.2x faster for the same file.
 *
 * Written at crf 26 rather than the 10 a 4-pixel block uses. The finer pattern
 * costs x264 more bits at any quality, and there is margin to buy them back:
 * 26 is the quality where the master comes out no larger than the wide grid's
 * for the same file — smaller, measured — while still recovering byte-identical
 * data from a simulated transcode ten crf steps past what YouTube is estimated
 * to apply. It first drops frames at crf 48, and stays inside the parity budget
 * even there.
 */
export const DENSE: Layout = layoutFor('dense', 2, '26', 1080);

/** 4-pixel blocks: 15992 bytes a frame. Every video written before this existed. */
export const WIDE: Layout = layoutFor('wide', 4, '10', 1080);

/**
 * 2-pixel blocks drawn straight at 3840x2160: 257656 bytes a frame, 5.9 MiB a
 * second — four times `dense`.
 *
 * The margin `dense` buys by drawing at 1080p and doubling is real, and this
 * spends it. What it buys back is everything downstream: a 2 GiB file is 2.6 GB
 * of video instead of 10.5, and a quarter of the frames to decode. Measured on
 * the pipeline as it stands, that is the difference between a restore of an
 * hour and one of a few minutes.
 *
 * The trade is that it can only ever be read from a 2160p rendition — at 1080p
 * a block is half a pixel, which is not a block at all — and YouTube spends
 * fewer bits per pixel up there than it does at 1080p. That is the number the
 * round-trip test exists to hold: this stays out of `DEFAULT_LAYOUT` until it
 * survives a real upload, and `CODEC_LAYOUT=ultra` is how it gets one.
 */
export const ULTRA: Layout = layoutFor('ultra', 2, '20', 2160, { w: UPSCALE_W, h: UPSCALE_H });

/**
 * Candidates a decoder tries, densest first.
 *
 * Nothing in a frame announces which layout wrote it — the header is drawn
 * inside the pattern, so reading it already needs the answer. The decoder
 * finds out by parsing instead: a 4-byte magic and a CRC over the whole frame
 * do not accept the wrong grid.
 */
// Densest first: the decoder tries each against a frame until one parses, and
// a coarser grid can misread a finer one's frame as noise rather than failing
// cleanly. `ultra` leads because a video written by it is unreadable by the
// other two, so a wrong guess there is not a near miss.
export const LAYOUTS: Layout[] = [ULTRA, DENSE, WIDE];

export const DEFAULT_LAYOUT = DENSE;

/** The layout a stored id names, falling back to the one videos used to use. */
export function layoutById(id: string | null | undefined): Layout {
  return LAYOUTS.find((layout) => layout.id === id) ?? WIDE;
}

/**
 * The layout to write with.
 *
 * Overridable, because the choice is a trade an instance is allowed to refuse:
 * `CODEC_LAYOUT=wide` keeps every video readable from a 1080p rendition, at
 * four times the video length and four times the encoding.
 */
export function encodingLayout(): Layout {
  return layoutById(process.env.CODEC_LAYOUT ?? DEFAULT_LAYOUT.id);
}
