import { basename } from 'node:path';
import { FPS, RS_K, RS_M } from './geometry.ts';
import { encodingLayout, type Layout } from './layout.ts';
import { openStream, openStreamReader } from './container.ts';
import { encodeGroupBytes } from './ecc.ts';
import { buildHeader, renderFrame } from './frame.ts';
import { openVideoSink } from './ffmpeg.ts';

export interface EncodeResult {
  groups: number;
  frames: number;
  streamBytes: number;
  originalBytes: number;
  /** Which grid wrote this video. A decoder needs it; it stores it per file. */
  layout: Layout['id'];
}

/**
 * Turns a file into the video that holds it.
 *
 * The input is never held in memory. It used to be, three times over — the
 * file, the container stream concatenated in front of it, and a padded copy
 * sized to whole groups — which measured at 5.6 GiB resident for a 600 MB
 * upload and is what capped uploads at two gigabytes. Now the payload stays
 * on disk and this reads one group of it at a time, so what is live is a
 * group: a megabyte and a half on the dense grid, whatever the file weighs.
 */
export async function encodeFile(
  inputPath: string,
  outputPath: string,
  onProgress?: (done: number, total: number) => void,
  layout: Layout = encodingLayout(),
): Promise<EncodeResult> {
  const source = await openStream(inputPath, basename(inputPath), `${outputPath}.gz`);
  const reader = await openStreamReader(source);

  const streamBytes = source.header.length + source.payloadLength;
  const groups = Math.ceil(streamBytes / layout.groupBytes);

  // One group buffer for the whole encode. The reader zero-fills whatever is
  // past the end of the stream, so the last group is padded without a second
  // copy of anything.
  const group = Buffer.alloc(layout.groupBytes);

  // The audio track is cut to this rather than trimmed against the video, so
  // the sink has to be told how long the video will be. It is known here and
  // nowhere later: a group is always `GROUP_FRAMES` frames.
  const sink = openVideoSink(outputPath, layout, (groups * (RS_K + RS_M)) / FPS);
  try {
    for (let g = 0; g < groups; g++) {
      await reader.read(group, g * layout.groupBytes, layout.groupBytes);
      const parity = await encodeGroupBytes(group, layout.shardBytes);

      for (let i = 0; i < RS_K + RS_M; i++) {
        const shard =
          i < RS_K
            ? group.subarray(i * layout.shardBytes, (i + 1) * layout.shardBytes)
            : parity.subarray((i - RS_K) * layout.shardBytes, (i - RS_K + 1) * layout.shardBytes);
        const header = buildHeader({ groupIndex: g, shardIndex: i, flags: 0 }, shard);
        await sink.write(renderFrame(header, shard, layout));
      }
      onProgress?.(g + 1, groups);
    }
  } finally {
    await sink.close();
    await reader.close();
    await source.close();
  }

  return {
    groups,
    frames: groups * (RS_K + RS_M),
    streamBytes,
    originalBytes: source.meta.originalSize,
    layout: layout.id,
  };
}
