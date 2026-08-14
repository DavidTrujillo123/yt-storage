import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { GROUP_BYTES, RS_K, SHARD_BYTES } from './geometry.ts';
import { pack } from './container.ts';
import { encodeGroup } from './ecc.ts';
import { buildHeader, renderFrame } from './frame.ts';
import { openVideoSink } from './ffmpeg.ts';

export interface EncodeResult {
  groups: number;
  frames: number;
  streamBytes: number;
  originalBytes: number;
}

export async function encodeFile(
  inputPath: string,
  outputPath: string,
  onProgress?: (done: number, total: number) => void,
): Promise<EncodeResult> {
  const data = await readFile(inputPath);
  const { stream } = pack(basename(inputPath), data);

  const groups = Math.ceil(stream.length / GROUP_BYTES);
  const padded = Buffer.alloc(groups * GROUP_BYTES);
  stream.copy(padded);

  const sink = openVideoSink(outputPath);
  try {
    for (let g = 0; g < groups; g++) {
      const base = g * GROUP_BYTES;
      const dataShards = Array.from({ length: RS_K }, (_, i) =>
        padded.subarray(base + i * SHARD_BYTES, base + (i + 1) * SHARD_BYTES),
      );
      const parityShards = await encodeGroup(dataShards);

      for (const [i, shard] of [...dataShards, ...parityShards].entries()) {
        const header = buildHeader({ groupIndex: g, shardIndex: i, flags: 0 }, shard);
        await sink.write(renderFrame(header, shard));
      }
      onProgress?.(g + 1, groups);
    }
  } finally {
    await sink.close();
  }

  return {
    groups,
    frames: groups * (RS_K + 6),
    streamBytes: stream.length,
    originalBytes: data.length,
  };
}
