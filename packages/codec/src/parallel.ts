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
 * How many ranges run at once, and why the answer is one until asked otherwise.
 *
 * Splitting the decode across cores works — it is correct, and it is faster —
 * but only just: measured on a 2 GiB restore served at 2160p, 660 seconds
 * against 750 for the sequential decode, an 12% saving for five times the CPU
 * (1114% against 225%). That ratio says the wall is not the core count. At
 * 41,700 frames in 660 seconds this machine is decoding about 63 frames a
 * second of 4K VP9 however the work is sliced, and five ffmpeg processes
 * contend for memory bandwidth rather than adding throughput.
 *
 * So it ships off. `CODEC_DECODE_JOBS` turns it on for a machine with more of
 * whatever this one ran out of, and `suggestedJobs()` is a sensible value for
 * it there. Twelve percent is not worth five times the power draw by default,
 * and a knob that lies about its benefit is worse than no knob.
 */
export function decodeJobs(): number {
  const asked = Number(process.env.CODEC_DECODE_JOBS);
  if (Number.isFinite(asked) && asked >= 1) return Math.floor(asked);
  return 1;
}

/**
 * A reasonable number of ranges for this machine, for whoever turns it on.
 *
 * Half the cores in ranges and the other half in the samplers underneath them.
 * The alternative was measured and is worse: eight ranges with ten workers
 * each is eighty threads on twelve cores, and the decode spent its time being
 * rescheduled — thirteen minutes to reach a quarter of a file the sequential
 * decode finished in twelve and a half.
 */
export function suggestedJobs(): number {
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
