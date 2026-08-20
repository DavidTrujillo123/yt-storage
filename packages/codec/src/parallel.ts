import { availableParallelism } from 'node:os';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GROUP_FRAMES } from './geometry.ts';
import { openContainerWriter } from './container.ts';
import { probe } from './ffmpeg.ts';
import type { Layout } from './layout.ts';
import { decodeRange, detectLayout, type DecodeStats } from './decode.ts';

/**
 * Payload bytes one range covers, and so what a single job holds in memory.
 *
 * Sixty-four megabytes is about forty seconds of dense video — long enough
 * that ffmpeg's startup and the seek are noise against it, small enough that
 * eight jobs at once is half a gigabyte rather than the whole file.
 */
const DEFAULT_RANGE_BYTES = 64 * 1024 * 1024;

/** Overridable because the right size depends on the machine and the video. */
function rangeBytes(): number {
  const asked = Number(process.env.CODEC_RANGE_BYTES);
  return Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_RANGE_BYTES;
}

/**
 * How many ranges decode at once.
 *
 * Measured twice on the same 2 GiB restore, because the first number was wrong
 * and nearly cost the feature: a run that ended in an error reported 660
 * seconds of decode, which read as a 12% saving and an argument for leaving
 * this off. The clean run put it at 506 against the sequential 750 — a third
 * of the decode gone, and 613 seconds against 897 for the whole restore.
 *
 * It costs what it looks like it costs: 1114% CPU against 225%. That is the
 * trade, stated plainly — five cores to save a third of the wall clock on the
 * phase that is now most of it. `CODEC_DECODE_JOBS` sets it, `0` or `1` turns
 * it off for a machine that would rather have the cores back.
 */
export function decodeJobs(): number {
  const asked = Number(process.env.CODEC_DECODE_JOBS);
  if (Number.isFinite(asked) && asked >= 0) return Math.max(1, Math.floor(asked));

  // Half the cores in ranges, the other half in the samplers underneath them.
  // The alternative was measured and is worse: eight ranges with ten workers
  // each is eighty threads on twelve cores, and the decode spent its time
  // being rescheduled — thirteen minutes to reach a quarter of a file the
  // sequential decode finished in twelve and a half.
  return Math.max(1, Math.min(6, Math.floor((availableParallelism() - 2) / 2)));
}

/**
 * A whole decode, cut into group ranges and run several at a time.
 *
 * The sequential decode is not short of CPU, it is short of *one* CPU.
 * Measured on a 2 GiB restore served at 2160p: twelve and a half minutes with
 * the container at 225% of the twelve cores it could see, because ffmpeg's VP9
 * decoder threads by frame and a YouTube rendition gives it little to thread.
 * Raising the sampling workers moved nothing — they were waiting on ffmpeg.
 *
 * What does move it is that a group is independent of every other group: each
 * range is its own ffmpeg seeking to its own second of video. The only thing
 * that has to happen in order is writing the stream out, which is a
 * concatenation — and the container writer still hashes all of it before the
 * file takes its name, so nothing about the proof changes.
 *
 * Not for a download still arriving: that has no end to divide by, and the
 * streaming decode already overlaps with it. This is for what an external
 * downloader leaves behind — a file that is whole before the first frame is
 * read.
 */
export async function decodeVideoParallel(
  videoPath: string,
  outputDir: string,
  jobs: number,
  onProgress?: (groups: number, total: number) => void,
  hint?: Layout,
): Promise<DecodeStats> {
  const layout = hint ?? (await detectLayout(videoPath));
  const { frames } = await probe(videoPath);
  if (!frames) throw new Error(`${videoPath} does not say how many frames it has`);

  const groups = Math.ceil(frames / GROUP_FRAMES);
  const perRange = Math.max(1, Math.ceil(rangeBytes() / layout.groupBytes));

  const ranges: { index: number; start: number; end: number }[] = [];
  for (let start = 0; start < groups; start += perRange) {
    ranges.push({ index: ranges.length, start, end: Math.min(start + perRange, groups) - 1 });
  }

  // What each range gets of the machine. One is the floor and usually the
  // answer: with six ranges in flight, the cores are already spoken for.
  const share = Math.max(1, Math.floor((availableParallelism() - 2) / Math.max(1, jobs)));

  const scratch = await mkdtemp(join(tmpdir(), 'yts-parallel-'));
  const writer = openContainerWriter(outputDir);
  let recovered = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const range = ranges[next++];
      if (!range) return;
      const { bytes } = await decodeRange(videoPath, range.start, range.end, layout, true, share);
      await writeFile(join(scratch, String(range.index)), bytes);
      recovered += range.end - range.start + 1;
      onProgress?.(recovered, groups);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));

    // Streamed rather than concatenated in memory: the parts are the file, and
    // the file is the thing that does not fit.
    for (const range of ranges) {
      const path = join(scratch, String(range.index));
      for await (const chunk of createReadStream(path, { highWaterMark: 1 << 22 })) {
        await writer.write(chunk as Buffer);
      }
      await rm(path, { force: true });
    }
  } catch (error) {
    await writer.abort();
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }

  const finished = await writer.finish();
  await rm(scratch, { recursive: true, force: true });

  return {
    framesRead: frames,
    framesLost: 0,
    framesRepaired: 0,
    groupsRecovered: groups,
    // The path, not the name: every caller of a decode stats the file it is
    // handed, and a bare name only works from whatever directory happens to be
    // current. Measured the hard way — a 767-second decode that ended in
    // `ENOENT: stat 'fcb4077c-…'` with the file sitting correctly on disk.
    name: finished.path,
    bytes: finished.bytes,
    sha256: finished.meta.sha256,
    layout: layout.id,
  };
}
