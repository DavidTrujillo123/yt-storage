import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { FPS, HEIGHT, MIN_PIXELS_PER_BLOCK, UPSCALE_H, UPSCALE_W, WIDTH } from './geometry.ts';
import type { Layout } from './layout.ts';

/**
 * Frames are piped to ffmpeg as raw grayscale and upscaled nearest-neighbour on
 * the way in. Uploading 4K of a 1080p signal is deliberate: YouTube budgets
 * bitrate by resolution, so the same information arrives with far less DCT
 * damage than a native 1080p upload would suffer.
 */
export interface VideoSink {
  write(frame: Buffer): Promise<void>;
  close(): Promise<void>;
}

export function openVideoSink(outPath: string, layout: Layout, quiet = true): VideoSink {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    '-s', `${WIDTH}x${HEIGHT}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    // A silent audio track. Not decoration: YouTube treats a video with no
    // audio stream as a special case and may never produce the muxed
    // renditions downloaders expect, and yt-dlp's default format selection
    // fails outright on audio-less videos. A few kbit/s buys normal handling.
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=mono:sample_rate=8000',
    '-shortest',
    '-map', '0:v',
    '-map', '1:a',
    '-c:a', 'aac',
    '-b:a', '8k',
    '-vf', `scale=${UPSCALE_W}:${UPSCALE_H}:flags=neighbor,format=yuv420p`,
    '-c:v', 'libx264',
    // Per layout: a finer grid costs x264 more bits at the same quality, and
    // has the margin at 2160p to give some of them back.
    '-crf', layout.crf,
    '-preset', 'veryfast',
    '-g', '30',
    '-movflags', '+faststart',
    outPath,
  ];
  if (quiet) args.unshift('-loglevel', 'error');

  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] });
  const exited = once(proc, 'close');

  return {
    async write(frame) {
      if (!proc.stdin.write(frame)) await once(proc.stdin, 'drain');
    },
    async close() {
      proc.stdin.end();
      const [code] = (await exited) as [number];
      if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    },
  };
}

/**
 * Dimensions, and the frame count when the container will admit to one.
 *
 * `nb_frames` is missing or `N/A` in plenty of streams — a remuxed download in
 * particular — so duration is the fallback, and null is the honest answer when
 * neither is there. A decoder that reports "frame 4000 of nothing" is still
 * better than one that invents a denominator.
 */
export async function probe(
  path: string,
): Promise<{ width: number; height: number; frames: number | null }> {
  const proc = spawn('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,duration',
    // Named fields, not positional ones. `csv=p=0` omits what a stream does
    // not carry instead of leaving a hole, so a video with no `nb_frames` —
    // every remuxed download — handed its duration to whoever read the third
    // column, and a 28 second video reported 28 frames to a progress bar
    // expecting 840.
    '-of', 'default=noprint_wrappers=1',
    path,
  ]);
  let out = '';
  proc.stdout.on('data', (c) => (out += c));
  const [code] = (await once(proc, 'close')) as [number];
  if (code !== 0) throw new Error(`ffprobe failed on ${path}`);

  const fields = new Map<string, string>();
  for (const line of out.trim().split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1));
  }

  const rawWidth = fields.get('width');
  const rawHeight = fields.get('height');
  const rawFrames = fields.get('nb_frames');
  const rawDuration = fields.get('duration');
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (!width || !height) throw new Error(`could not read dimensions from ${path}`);

  const counted = Number(rawFrames);
  const seconds = Number(rawDuration);
  const frames = Number.isFinite(counted) && counted > 0
    ? counted
    : Number.isFinite(seconds) && seconds > 0
      ? Math.round(seconds * FPS)
      : null;

  return { width, height, frames };
}

export interface RawFrames {
  width: number;
  height: number;
  frameSize: number;
  /** Raw grayscale bytes, in whatever sized pieces the pipe delivers them. */
  chunks: AsyncIterable<Buffer>;
  /** Stops ffmpeg for a reader that is giving up before the end. */
  close(): void;
}

/**
 * Opens the raw grayscale pipe for a video.
 *
 * Chunks rather than frames, because who cuts them into frames matters: the
 * decoder copies each one straight into a buffer a worker thread is waiting
 * on, and going through an intermediate frame Buffer would be a second copy of
 * every pixel for nothing.
 */
export async function openRawFrames(
  path: string,
  layout: Layout | null = null,
  limit?: number,
): Promise<RawFrames> {
  const source = await probe(path);

  // A rendition with more pixels than the layout needs is downscaled here
  // rather than read at full size. The extra pixels carry nothing — the signal
  // is the same grid whatever height YouTube served it at — but they are real
  // bytes through a pipe and a real copy per frame, four times as many at
  // 2160p. ffmpeg averages them down in C, cheaper than reading them whole.
  //
  // The floor is what the sampler needs, not the canvas: at 2-pixel blocks
  // that is 2160p, and downscaling to 1080p would throw the video away.
  const wantW = layout ? layout.gridW * MIN_PIXELS_PER_BLOCK : 0;
  const wantH = layout ? layout.gridH * MIN_PIXELS_PER_BLOCK : 0;
  const shrink = layout !== null && source.height > wantH;
  const width = shrink ? wantW : source.width;
  const height = shrink ? wantH : source.height;

  const proc = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-i', path,
    ...(shrink ? ['-vf', `scale=${wantW}:${wantH}:flags=area`] : []),
    ...(limit ? ['-frames:v', String(limit)] : []),
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  return {
    width,
    height,
    frameSize: width * height,
    chunks: proc.stdout,
    close: () => void proc.kill('SIGKILL'),
  };
}

/** Yields decoded grayscale frames, downscaled to what the layout needs. */
export async function* readFrames(
  path: string,
  layout: Layout | null = null,
  limit?: number,
): AsyncGenerator<{ data: Buffer; width: number; height: number }> {
  const { width, height, frameSize, chunks } = await openRawFrames(path, layout, limit);

  let pending: Buffer[] = [];
  let pendingBytes = 0;

  for await (const chunk of chunks) {
    pending.push(chunk);
    pendingBytes += chunk.length;

    while (pendingBytes >= frameSize) {
      const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
      yield { data: joined.subarray(0, frameSize), width, height };
      const rest = joined.subarray(frameSize);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  }
}

export interface SimulateOptions {
  /** VP9 constant quality, 0 (lossless) to 63 (worst). YouTube lands near 32. */
  crf?: number;
  /** Serve the result at a lower resolution, as YouTube does on weak playback. */
  height?: number;
}

/**
 * Re-encodes a video the way YouTube would: VP9 at constant quality.
 *
 * Note that `-b:v` alone does not constrain libvpx-vp9 — it stays in VBR and
 * quietly ignores the target, which makes bitrate-based tests look like passes
 * when no degradation happened at all. `-crf` with `-b:v 0` is what actually
 * controls quality here.
 */
export async function simulateYouTube(
  inPath: string,
  outPath: string,
  { crf = 32, height }: SimulateOptions = {},
): Promise<void> {
  const args = [
    '-loglevel', 'error',
    '-y',
    '-i', inPath,
    '-c:v', 'libvpx-vp9',
    '-crf', String(crf),
    '-b:v', '0',
    '-row-mt', '1',
    '-deadline', 'good',
    '-cpu-used', '2',
    '-pix_fmt', 'yuv420p',
  ];
  if (height) args.push('-vf', `scale=-2:${height}`);
  args.push(outPath);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  const [code] = (await once(proc, 'close')) as [number];
  if (code !== 0) throw new Error(`ffmpeg simulate exited with code ${code}`);
}
