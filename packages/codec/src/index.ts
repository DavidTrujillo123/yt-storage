export { encodeFile, type EncodeResult } from './encode.ts';
export { decodeVideo, detectLayout, type DecodeStats } from './decode.ts';
export { pack, unpack, type ContainerMeta } from './container.ts';
export { probe, simulateYouTube, type SimulateOptions } from './ffmpeg.ts';
export {
  FPS,
  GROUP_FRAMES,
  HEIGHT,
  MIN_PIXELS_PER_BLOCK,
  RS_K,
  RS_M,
  UPSCALE_H,
  WIDTH,
} from './geometry.ts';
export {
  DEFAULT_LAYOUT,
  DENSE,
  LAYOUTS,
  WIDE,
  encodingLayout,
  layoutById,
  type Layout,
  type LayoutId,
} from './layout.ts';

/**
 * Minimum served height a video written before layouts existed needs.
 *
 * Measured, not guessed: 900p round-trips cleanly and 810p fails outright,
 * because below ~3.3 pixels per 4-px block the frame stops being sampleable.
 * A video's own layout says what it needs — `layoutById(file.layout).minHeight`
 * — and this is what that answers for the ones that predate the column.
 */
export const MIN_DECODABLE_HEIGHT = 1080;
