export { encodeFile, type EncodeResult } from './encode.ts';
export { decodeVideo, type DecodeStats } from './decode.ts';
export { pack, unpack, type ContainerMeta } from './container.ts';
export { probe, simulateYouTube, type SimulateOptions } from './ffmpeg.ts';
export {
  FPS,
  GROUP_BYTES,
  GROUP_FRAMES,
  HEIGHT,
  RS_K,
  RS_M,
  SHARD_BYTES,
  UPSCALE_H,
  WIDTH,
} from './geometry.ts';

/**
 * Minimum served height the decoder can read. Measured, not guessed: 900p
 * round-trips cleanly and 810p fails outright, because below ~3.3 pixels per
 * 4-px block the frame stops being sampleable. Downloads must enforce this.
 */
export const MIN_DECODABLE_HEIGHT = 1080;
