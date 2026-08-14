/**
 * Physical layer geometry.
 *
 * Every bit is drawn as a solid BLOCK x BLOCK square, pure black or pure white,
 * on a grayscale canvas. The canvas is upscaled with nearest-neighbour before
 * encoding so YouTube allocates a 4K bitrate budget to what is really 1080p of
 * information — the single most effective defence against its re-encode.
 *
 * A one-block checkerboard border frames the canvas. The decoder uses it to
 * recover the black and white reference levels after compression has shifted
 * them, so the threshold adapts per frame instead of being hardcoded at 128.
 */

export const BLOCK = 4;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const GRID_W = WIDTH / BLOCK; // 480
export const GRID_H = HEIGHT / BLOCK; // 270

/** Usable area, excluding the calibration border. */
export const INNER_W = GRID_W - 2; // 478
export const INNER_H = GRID_H - 2; // 268
export const INNER_BITS = INNER_W * INNER_H; // 128104

/** Per-frame header, at the start of the inner bit stream. */
export const HEADER_BITS = 128;
export const HEADER_BYTES = HEADER_BITS / 8; // 16

/**
 * Payload bytes per frame. Floored to a multiple of 8 because
 * @ronomon/reed-solomon requires shard sizes divisible by 8.
 */
export const SHARD_BYTES = Math.floor((INNER_BITS - HEADER_BITS) / 8 / 8) * 8; // 15992

/** Reed-Solomon group: 24 data frames + 6 parity frames. */
export const RS_K = 24;
export const RS_M = 6;
export const GROUP_FRAMES = RS_K + RS_M; // 30
export const GROUP_BYTES = RS_K * SHARD_BYTES; // 383808

export const FPS = 30;

/** Nearest-neighbour upscale target handed to ffmpeg. */
export const UPSCALE_W = WIDTH * 2; // 3840
export const UPSCALE_H = HEIGHT * 2; // 2160

export const MAGIC = 0x49534756; // "ISGV"

/** True when the checkerboard border block at (row, col) should be white. */
export function borderIsWhite(row: number, col: number): boolean {
  return (row + col) % 2 === 0;
}
