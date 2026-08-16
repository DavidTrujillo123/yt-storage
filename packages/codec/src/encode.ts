import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RS_K, RS_M } from './geometry.ts';
import { encodingLayout, type Layout } from './layout.ts';
import { pack } from './container.ts';
import { encodeGroup } from './ecc.ts';
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

export async function encodeFile(
  inputPath: string,
  outputPath: string,
  onProgress?: (done: number, total: number) => void,
  layout: Layout = encodingLayout(),
): Promise<EncodeResult> {
  const data = await readFile(inputPath);
  const { stream } = pack(basename(inputPath), data);

  const groups = Math.ceil(stream.length / layout.groupBytes);
  const padded = Buffer.alloc(groups * layout.groupBytes);
  stream.copy(padded);

  const sink = openVideoSink(outputPath, layout);
  try {
    for (let g = 0; g < groups; g++) {
      const base = g * layout.groupBytes;
      const dataShards = Array.from({ length: RS_K }, (_, i) =>
        padded.subarray(base + i * layout.shardBytes, base + (i + 1) * layout.shardBytes),
      );
      const parityShards = await encodeGroup(dataShards);

      for (const [i, shard] of [...dataShards, ...parityShards].entries()) {
        const header = buildHeader({ groupIndex: g, shardIndex: i, flags: 0 }, shard);
        await sink.write(renderFrame(header, shard, layout));
      }
      onProgress?.(g + 1, groups);
    }
  } finally {
    await sink.close();
  }

  return {
    groups,
    frames: groups * (RS_K + RS_M),
    streamBytes: stream.length,
    originalBytes: data.length,
    layout: layout.id,
  };
}
