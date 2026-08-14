import { writeFile } from 'node:fs/promises';
import { GROUP_FRAMES, RS_K } from './geometry.ts';
import { unpack } from './container.ts';
import { recoverGroup } from './ecc.ts';
import { decodeFrame, sampleFrame } from './frame.ts';
import { readFrames } from './ffmpeg.ts';

export interface DecodeStats {
  framesRead: number;
  framesLost: number;
  framesRepaired: number;
  groupsRecovered: number;
  name: string;
  bytes: number;
  sha256: string;
}

export async function decodeVideo(
  videoPath: string,
  outputDir: string,
  onProgress?: (frames: number) => void,
): Promise<DecodeStats> {
  const groups = new Map<number, (Buffer | null)[]>();
  const stats = { framesRead: 0, framesLost: 0, framesRepaired: 0, groupsRecovered: 0 };

  for await (const frame of readFrames(videoPath)) {
    stats.framesRead++;
    onProgress?.(stats.framesRead);

    const decoded = decodeFrame(sampleFrame(frame.data, frame.width, frame.height));
    if (!decoded) {
      stats.framesLost++;
      continue;
    }
    if (decoded.repairedBits > 0) stats.framesRepaired++;

    const { groupIndex, shardIndex } = decoded.header;
    if (shardIndex >= GROUP_FRAMES) continue;

    let slots = groups.get(groupIndex);
    if (!slots) {
      slots = new Array(GROUP_FRAMES).fill(null);
      groups.set(groupIndex, slots);
    }
    slots[shardIndex] = decoded.payload;
  }

  if (groups.size === 0) throw new Error('no readable frames found');

  const indices = [...groups.keys()].sort((a, b) => a - b);
  const expected = indices[indices.length - 1] + 1;
  if (indices.length !== expected) {
    const missing = Array.from({ length: expected }, (_, i) => i).filter((i) => !groups.has(i));
    throw new Error(`missing entire groups: ${missing.join(', ')}`);
  }

  const parts: Buffer[] = [];
  for (const g of indices) {
    const shards = await recoverGroup(groups.get(g)!);
    stats.groupsRecovered++;
    for (let i = 0; i < RS_K; i++) parts.push(shards[i]);
  }

  // The stream is padded to a whole group; unpack() reads the true length from
  // the container header and ignores the tail.
  const { data, meta } = unpack(Buffer.concat(parts));
  const outPath = `${outputDir}/${meta.name}`;
  await writeFile(outPath, data);

  return { ...stats, name: outPath, bytes: data.length, sha256: meta.sha256 };
}
