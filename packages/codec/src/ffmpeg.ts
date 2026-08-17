import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { FPS, HEIGHT, UPSCALE_H, UPSCALE_W, WIDTH } from './geometry.ts';
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

/**
 * The x264 preset, and the one knob worth exposing on this whole path.
 *
 * `ultrafast` because ffmpeg is not part of the encode's cost, it is
 * essentially all of it: on a 40 MiB fixture the whole `encodeFile` measured
 * 25.3s and ffmpeg alone on the same frames measured 24.9s. A slower preset
 * buys a smaller master, which is worth almost nothing here — uploading one
 * measured ten times faster than producing it.
 *
 * Overridable so a machine on a thin connection can make the opposite trade
 * without a rebuild, and so a suspected regression can be bisected against the
 * old default by setting `CODEC_X264_PRESET=veryfast`.
 */
export function x264Preset(): string {
  return process.env.CODEC_X264_PRESET || 'ultrafast';
}

export function openVideoSink(
  outPath: string,
  layout: Layout,
  seconds: number,
  quiet = true,
): VideoSink {
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
    //
    // Cut to the length of the video with `-t` rather than left running and
    // trimmed with `-shortest`. The output is identical either way and the
    // memory is not: measured on 840 frames, `-shortest` peaked at 4.4 GiB
    // where this peaks at 889 MiB. That five-fold difference was the whole of
    // the encoder's memory ceiling — the JavaScript side of an encode is
    // about 150 MiB whatever the file weighs — and so the reason uploads were
    // capped at two gigabytes.
    '-f', 'lavfi',
    '-t', seconds.toFixed(3),
    '-i', 'anullsrc=channel_layout=mono:sample_rate=8000',
    '-map', '0:v',
    '-map', '1:a',
    '-c:a', 'aac',
    '-b:a', '8k',
    '-vf', `scale=${UPSCALE_W}:${UPSCALE_H}:flags=neighbor,format=yuv420p`,
    '-c:v', 'libx264',
    // Per layout: a finer grid costs x264 more bits at the same quality, and
    // has the margin at 2160p to give some of them back.
    '-crf', layout.crf,
    '-preset', x264Preset(),
    // The one thing `ultrafast` turns off that this content cannot afford to
    // lose. Measured on 840 real frames: veryfast is 24.9s for a 169 MiB
    // master, ultrafast is 6.4s for 458 MiB — the preset drops CABAC, and
    // entropy coding is most of what keeps a master of random noise small.
    // Putting only that back costs 1.8s and gives the size straight back:
    // 8.2s for 198 MiB. Three times faster for seventeen percent more upload,
    // which is a trade worth making because an encode measured ten times
    // longer than the upload that follows it.
    //
    // Nothing else was worth it — subme, me=hex, 8x8dct and deblocking all
    // cost time without shrinking the file. That is what random noise drawn as
    // flat, transform-aligned squares does to a motion-compensating encoder:
    // there is nothing between frames to find.
    '-x264-params', 'cabac=1',
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
    // Duration is asked of the *container*, not of the stream, and that is the
    // whole of why a decode used to report no progress at all. yt-dlp writes a
    // fragmented MP4 under `--no-part`, and fMP4 carries neither `nb_frames`
    // nor a stream duration — both come back N/A on every download this app
    // makes. The container knows: measured on a real restore, `stream=duration`
    // was N/A while `format=duration` was 446.000000, which at 30 fps is the
    // 13,380-frame denominator a progress bar was missing.
    //
    // Only one `duration` is requested, so there is no second one to collide
    // with it in the map below and no dependence on which section ffprobe
    // prints first.
    '-show_entries', 'stream=width,height,nb_frames:format=duration',
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
/**
 * Reads a file that is still being written, ending only when it is finished.
 *
 * A restore used to download the whole video and only then start decoding —
 * two costs in series, measured at 370 seconds and 201. They do not have to be:
 * the decoder is already streaming, it flushes each recovered group to disk as
 * it passes, and the only thing tying it to a completed download was ffmpeg
 * stopping at whatever end-of-file it found.
 *
 * yt-dlp writes its output in order under `--no-part`, and the fragmented MP4
 * it produces carries its metadata up front — measured mid-download, ffprobe
 * reported the full 446-second duration off a file that was a third there. So
 * the prefix of the file is always a valid stream; it is simply short. This
 * follows it: hand the bytes on as they land, sleep when there are none, and
 * finish once the writer says it is done *and* there is nothing left to read.
 *
 * `donePath` is how the writer says so. It is a sentinel file rather than a
 * signal or a socket because the two sides are separate processes — the codec
 * runs as a CLI child — and a file appearing is the smallest thing that crosses
 * that boundary without inventing a protocol.
 */
export function followFile(path: string, donePath: string): Readable {
  let offset = 0;
  let finishing = false;

  return new Readable({
    highWaterMark: 1 << 20,
    async read() {
      for (;;) {
        let size = 0;
        try {
          size = (await stat(path)).size;
        } catch {
          // The file may not exist for the first moments of a download.
        }

        if (size > offset) {
          const handle = await open(path, 'r');
          try {
            const length = Math.min(size - offset, 1 << 20);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            offset += bytesRead;
            this.push(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
          return;
        }

        // Caught up. Only stop once the writer has finished *and* a last look
        // found nothing new — checked in that order, so bytes written between
        // the two checks are never dropped.
        if (finishing) {
          this.push(null);
          return;
        }
        finishing = await stat(donePath).then(() => true).catch(() => false);
        if (!finishing) await new Promise((wake) => setTimeout(wake, 200));
      }
    },
  });
}

export async function openRawFrames(
  path: string,
  layout: Layout | null = null,
  limit?: number,
  startSeconds?: number,
  follow?: string,
): Promise<RawFrames> {
  const source = await probe(path);

  // A rendition with more pixels than the layout needs is downscaled here
  // rather than read at full size. The extra pixels carry nothing — the signal
  // is the same grid whatever height YouTube served it at — but they are real
  // bytes through a pipe and a real copy per frame, four times as many at
  // 2160p. ffmpeg averages them down in C, cheaper than reading them whole.
  //
  // The floor is what the sampler needs, not the canvas, and it is per layout:
  // the dense grid is measured readable at 1080p, which is two pixels a block,
  // so a 2160p rendition of it is four times the bytes through this pipe for
  // nothing. Asking every grid for four pixels a block — the wide grid's
  // number — is what kept 4K frames flowing for a signal that fits in 1080p.
  const wantW = layout ? layout.gridW * layout.pixelsPerBlock : 0;
  const wantH = layout ? layout.gridH * layout.pixelsPerBlock : 0;
  const shrink = layout !== null && source.height > wantH;
  const width = shrink ? wantW : source.width;
  const height = shrink ? wantH : source.height;

  const proc = spawn('ffmpeg', [
    '-loglevel', 'error',
    // Before -i, so ffmpeg seeks rather than decodes and throws away. It lands
    // on the keyframe at or before the request and the caller gets whatever
    // frames follow — which is fine here and deliberately not corrected with
    // an output-side seek, because every frame states its own group and shard
    // in its header. Position is read from the frames, never counted from the
    // start of the pipe.
    ...(startSeconds ? ['-ss', String(startSeconds)] : []),
    // Following means reading a file nobody has finished writing, which a path
    // cannot express — ffmpeg would stop at whatever end it found. The bytes
    // arrive on stdin instead, from a reader that waits rather than ends. The
    // geometry above still came from probing the file, which works from its
    // first fragment on.
    '-i', follow ? 'pipe:0' : path,
    ...(shrink ? ['-vf', `scale=${wantW}:${wantH}:flags=area`] : []),
    ...(limit ? ['-frames:v', String(limit)] : []),
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    'pipe:1',
  ], { stdio: [follow ? 'pipe' : 'ignore', 'pipe', 'inherit'] });

  if (follow) {
    const feed = followFile(path, follow);
    feed.pipe(proc.stdin!);
    // ffmpeg exiting first — on `-frames:v`, or on a stream it will not read —
    // leaves the follower writing into a closed pipe. Neither end is an error
    // worth failing a decode over; the frames already read are what count.
    proc.stdin!.on('error', () => feed.destroy());
  }

  return {
    width,
    height,
    frameSize: width * height,
    // Always a pipe: the stdio array above only ever varies at index 0, but a
    // computed tuple loses that for the type checker.
    chunks: proc.stdout!,
    close: () => void proc.kill('SIGKILL'),
  };
}

/** Yields decoded grayscale frames, downscaled to what the layout needs. */
export async function* readFrames(
  path: string,
  layout: Layout | null = null,
  limit?: number,
  startSeconds?: number,
  follow?: string,
): AsyncGenerator<{ data: Buffer; width: number; height: number }> {
  const { width, height, frameSize, chunks, close } = await openRawFrames(
    path,
    layout,
    limit,
    startSeconds,
    follow,
  );

  let pending: Buffer[] = [];
  let pendingBytes = 0;

  try {
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
  } finally {
    // A caller that stops early — layout detection, a partial read — would
    // otherwise leave ffmpeg decoding the rest of the video into a pipe
    // nobody reads.
    close();
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
