/**
 * Physical layer geometry.
 *
 * Every bit is drawn as a solid square, pure black or pure white, on a
 * grayscale canvas. The canvas is upscaled with nearest-neighbour before
 * encoding so YouTube allocates a 4K bitrate budget to what is really 1080p of
 * information — the single most effective defence against its re-encode.
 *
 * A one-block checkerboard border frames the canvas. The decoder uses it to
 * recover the black and white reference levels after compression has shifted
 * them, so the threshold adapts per frame instead of being hardcoded at 128.
 *
 * How wide that square is, and therefore how many bits fit on the canvas, is
 * the one thing that varies between videos: it lives in `layout.ts`.
 */

export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Per-frame header, at the start of the inner bit stream. */
export const HEADER_BITS = 128;
export const HEADER_BYTES = HEADER_BITS / 8; // 16

/** Reed-Solomon group: 24 data frames + 6 parity frames. */
export const RS_K = 24;
export const RS_M = 6;
export const GROUP_FRAMES = RS_K + RS_M; // 30

export const FPS = 30;

/** Nearest-neighbour upscale target handed to ffmpeg. */
export const UPSCALE_W = WIDTH * 2; // 3840
export const UPSCALE_H = HEIGHT * 2; // 2160

/**
 * Pixels per block a rendition must still carry for the sampler to read it.
 *
 * Measured, not guessed: a 4-pixel block round-trips byte-identical served at
 * 900p — 3.3 pixels a block — and fails outright at 810p. Four is the nearest
 * whole number above that cliff, and it lands every layout on a standard
 * YouTube rung. Each layout states the height it needs from it, and the
 * decoder uses it to decide how far ffmpeg may downscale on the way in.
 */
export const MIN_PIXELS_PER_BLOCK = 4;

export const MAGIC = 0x49534756; // "ISGV"

/** True when the checkerboard border block at (row, col) should be white. */
export function borderIsWhite(row: number, col: number): boolean {
  return (row + col) % 2 === 0;
}
