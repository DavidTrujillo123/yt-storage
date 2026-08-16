import { writeFile } from 'node:fs/promises';
import { GROUP_FRAMES, RS_K } from './geometry.ts';
import { unpack } from './container.ts';
import { recoverGroup } from './ecc.ts';
import { decodeFrame, sampleFrame } from './frame.ts';
import { openRawFrames, probe, readFrames, type RawFrames } from './ffmpeg.ts';
import { LAYOUTS, type Layout } from './layout.ts';
import { SamplePool, workerCount, type SampledShard } from './pool.ts';

export interface DecodeStats {
  framesRead: number;
  framesLost: number;
  framesRepaired: number;
  groupsRecovered: number;
  name: string;
  bytes: number;
  sha256: string;
  /** Which grid this video turned out to be written in. */
  layout: Layout['id'];
}

/** How many frames the detection pass will spend before giving up on a layout. */
const DETECT_FRAMES = 8;

/**
 * Works out which grid wrote a video by trying to read one.
 *
 * A frame carries its own header, but the header is drawn in the same grid as
 * everything else, so reading it needs the answer already. Parsing is the test
 * instead: a wrong grid samples the pattern at the wrong pitch and produces
 * bytes that fail the magic long before the CRC gets a say. The first frames
 * of a damaged video may fail for every layout, hence more than one attempt.
 */
export async function detectLayout(videoPath: string): Promise<Layout> {
  const candidates = [...LAYOUTS];

  // Read at native resolution: the frames have to stay sampleable for every
  // candidate, and each wants a different amount of detail kept.
  for await (const frame of readFrames(videoPath, null, DETECT_FRAMES)) {
    for (const layout of candidates) {
      const parsed = decodeFrame(sampleFrame(frame.data, frame.width, frame.height, layout), layout);
      if (parsed) return layout;
    }
  }

  throw new Error(
    `no readable frames found in ${videoPath} — it is not one of ours, or the rendition ` +
      `served is below ${Math.min(...LAYOUTS.map((l) => l.minHeight))}p`,
  );
}

type Groups = Map<number, (Buffer | null)[]>;
type Counters = { framesRead: number; framesLost: number; framesRepaired: number; groupsRecovered: number };

/** Files one sampled frame under its group, or counts it as lost. */
function place(groups: Groups, stats: Counters, shard: SampledShard): void {
  if (!shard.ok || !shard.payload) {
    stats.framesLost++;
    return;
  }
  if (shard.repairedBits > 0) stats.framesRepaired++;
  if (shard.shardIndex >= GROUP_FRAMES) return;

  let slots = groups.get(shard.groupIndex);
  if (!slots) {
    slots = new Array(GROUP_FRAMES).fill(null);
    groups.set(shard.groupIndex, slots);
  }
  slots[shard.shardIndex] = shard.payload;
}

/** The single-threaded read: also the fallback when threads are unavailable. */
async function collectInline(
  videoPath: string,
  layout: Layout,
  groups: Groups,
  stats: Counters,
  total: number | null,
  onProgress?: (frames: number, total: number | null) => void,
): Promise<void> {
  for await (const frame of readFrames(videoPath, layout)) {
    stats.framesRead++;
    onProgress?.(stats.framesRead, total);

    const decoded = decodeFrame(sampleFrame(frame.data, frame.width, frame.height, layout), layout);
    place(groups, stats, {
      ok: decoded !== null,
      groupIndex: decoded?.header.groupIndex ?? 0,
      shardIndex: decoded?.header.shardIndex ?? 0,
      repairedBits: decoded?.repairedBits ?? 0,
      payload: decoded?.payload ?? null,
    });
  }
}

/**
 * The same read, with the sampling spread over threads.
 *
 * The pipe is cut into frames straight into the buffer of a worker that is
 * already idle, so a frame is copied once — out of the pipe — rather than
 * assembled, sampled and only then filed. Awaiting a free worker is what keeps
 * ffmpeg from running ahead: the stream stays paused while every thread is busy.
 */
async function collectPooled(
  raw: RawFrames,
  groups: Groups,
  stats: Counters,
  total: number | null,
  pool: SamplePool,
  onProgress?: (frames: number, total: number | null) => void,
): Promise<void> {
  const { width, height, frameSize, chunks } = raw;

  let target: Uint8Array | null = null;
  let worker = -1;
  let filled = 0;

  try {
    for await (const chunk of chunks) {
      let at = 0;
      while (at < chunk.length) {
        if (!target) {
          worker = await pool.acquire();
          target = pool.frame(worker);
          filled = 0;
        }

        const take = Math.min(frameSize - filled, chunk.length - at);
        target.set(chunk.subarray(at, at + take), filled);
        filled += take;
        at += take;

        if (filled === frameSize) {
          stats.framesRead++;
          onProgress?.(stats.framesRead, total);
          pool.submit(worker, width, height, (shard: SampledShard) => place(groups, stats, shard));
          target = null;
        }
      }
    }
    await pool.drain();
  } finally {
    await pool.close();
  }
}

export async function decodeVideo(
  videoPath: string,
  outputDir: string,
  onProgress?: (frames: number, total: number | null) => void,
): Promise<DecodeStats> {
  const groups: Groups = new Map();
  const stats: Counters = { framesRead: 0, framesLost: 0, framesRepaired: 0, groupsRecovered: 0 };

  // Asked once, before the read, so progress has a denominator. ffprobe on a
  // local file is milliseconds against a decode measured in minutes.
  const total = onProgress ? (await probe(videoPath)).frames : null;

  // Which grid, before anything else: it decides how much of the video has to
  // be kept on the way in and how many bytes a frame is.
  const layout = await detectLayout(videoPath);

  // Threads are an optimisation, never a requirement: a runtime that will not
  // start one still decodes, one frame at a time, rather than failing. The
  // frame size comes from the open stream, which may be scaling the video
  // down, and never from the file's own dimensions.
  const workers = workerCount();
  const raw = workers > 1 ? await openRawFrames(videoPath, layout) : null;
  const pool = raw
    ? await SamplePool.open(raw.frameSize, workers, layout).catch(() => null)
    : null;

  if (raw && pool) await collectPooled(raw, groups, stats, total, pool, onProgress);
  else {
    raw?.close();
    await collectInline(videoPath, layout, groups, stats, total, onProgress);
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

  return { ...stats, name: outPath, bytes: data.length, sha256: meta.sha256, layout: layout.id };
}
