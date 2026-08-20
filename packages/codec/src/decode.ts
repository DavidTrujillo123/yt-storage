import { FPS, GROUP_FRAMES, RS_K } from './geometry.ts';
import { openContainerWriter } from './container.ts';
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
 * How far before a range a partial read starts.
 *
 * ffmpeg seeks to the keyframe at or before the timestamp it is given, and
 * YouTube's re-encode does not keep the master's keyframe on every group
 * boundary. Two seconds is cheap — two groups of frames read and discarded —
 * and the frames themselves say which group they are, so overshooting the
 * start costs nothing but them.
 */
const SEEK_SAFETY_SECONDS = 2;

/**
 * Works out which grid wrote a video by trying to read one.
 *
 * A frame carries its own header, but the header is drawn in the same grid as
 * everything else, so reading it needs the answer already. Parsing is the test
 * instead: a wrong grid samples the pattern at the wrong pitch and produces
 * bytes that fail the magic long before the CRC gets a say. The first frames
 * of a damaged video may fail for every layout, hence more than one attempt.
 */
export async function detectLayout(videoPath: string, follow?: string): Promise<Layout> {
  const candidates = [...LAYOUTS];

  // Following matters here as much as it does for the real read. Detection
  // needs only a handful of frames, but on a download still in flight there may
  // not be a handful yet — measured against a file a twelfth written, ffmpeg
  // reported "no readable frames found" and the whole restore failed on a video
  // that was perfectly good. Waiting for the frames costs nothing: `limit` ends
  // the read the moment enough of them arrive.
  //
  // Read at native resolution: the frames have to stay sampleable for every
  // candidate, and each wants a different amount of detail kept.
  for await (const frame of readFrames(videoPath, null, DETECT_FRAMES, undefined, follow)) {
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
type Counters = {
  framesRead: number;
  framesLost: number;
  framesRepaired: number;
  groupsRecovered: number;
  /** Highest group index any readable frame has claimed so far. */
  furthestGroup: number;
};

function counters(): Counters {
  return { framesRead: 0, framesLost: 0, framesRepaired: 0, groupsRecovered: 0, furthestGroup: -1 };
}

/**
 * Hands finished groups to whoever is writing them out, and is told how many
 * frames have been read so it can work out which groups those are.
 */
type Flush = (groups: Groups, stats: Counters, framesRead: number) => Promise<void>;

/**
 * How many groups a streaming decode keeps before writing them out.
 *
 * A group is only safe to write once every frame of it has been *sampled*, not
 * merely read — the worker pool answers out of order — so flushing means
 * waiting for the pool to go idle, which empties the pipeline for a moment.
 * Eight groups amortises that bubble over 240 frames while holding twelve
 * megabytes on the dense grid, which is the point of the exercise.
 */
const FLUSH_GROUPS = 8;

/** Files one sampled frame under its group, or counts it as lost. */
function place(groups: Groups, stats: Counters, shard: SampledShard): void {
  if (!shard.ok || !shard.payload) {
    stats.framesLost++;
    return;
  }
  if (shard.repairedBits > 0) stats.framesRepaired++;
  if (shard.groupIndex > stats.furthestGroup) stats.furthestGroup = shard.groupIndex;
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
  startSeconds?: number,
  enough?: (stats: Counters) => boolean,
  flush?: Flush,
): Promise<void> {
  for await (const frame of readFrames(videoPath, layout, undefined, startSeconds)) {
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
    if (enough?.(stats)) return;
    // Nothing is in flight on this path — the frame was sampled on the way in
    // — so a group is finished the moment the read has moved past it.
    if (flush && stats.framesRead % (GROUP_FRAMES * FLUSH_GROUPS) === 0) {
      await flush(groups, stats, stats.framesRead);
    }
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
  enough?: (stats: Counters) => boolean,
  flush?: Flush,
): Promise<void> {
  const { width, height, frameSize, chunks } = raw;

  let target: Uint8Array | null = null;
  let worker = -1;
  let filled = 0;
  let stop = false;

  try {
    for await (const chunk of chunks) {
      if (stop) break;
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
          // Checked between frames rather than per chunk: the answer only
          // changes when a worker files one, and a partial read that stops one
          // group late costs a frame, not a correctness bug.
          if (enough?.(stats)) {
            stop = true;
            break;
          }

          // A group is finished when every one of its frames has been
          // answered, not when the last one was handed out — the workers reply
          // out of order. Draining the pool is what turns "read past it" into
          // "done with it", and it is why this happens every eight groups
          // rather than every one.
          if (flush && stats.framesRead % (GROUP_FRAMES * FLUSH_GROUPS) === 0) {
            await pool.drain();
            await flush(groups, stats, stats.framesRead);
          }
        }
      }
    }
    await pool.drain();
  } finally {
    // The pipe outlives the loop when it broke early, and ffmpeg would go on
    // decoding the rest of the video into it.
    raw.close();
    await pool.close();
  }
}

/**
 * Reads a video into sampled groups, optionally starting partway in and
 * stopping early.
 *
 * The one place that decides between the threaded read and the inline one, so
 * a partial read and a whole-file read cannot drift apart.
 */
async function readGroups(
  videoPath: string,
  layout: Layout,
  total: number | null,
  onProgress?: (frames: number, total: number | null) => void,
  startSeconds?: number,
  enough?: (stats: Counters) => boolean,
  flush?: Flush,
  follow?: string,
): Promise<{ groups: Groups; stats: Counters }> {
  const groups: Groups = new Map();
  const stats = counters();

  // Threads are an optimisation, never a requirement: a runtime that will not
  // start one still decodes, one frame at a time, rather than failing. The
  // frame size comes from the open stream, which may be scaling the video
  // down, and never from the file's own dimensions.
  const workers = workerCount();
  const raw =
    workers > 1 ? await openRawFrames(videoPath, layout, undefined, startSeconds, follow) : null;
  const pool = raw
    ? await SamplePool.open(raw.frameSize, workers, layout).catch(() => null)
    : null;

  if (raw && pool) await collectPooled(raw, groups, stats, total, pool, onProgress, enough, flush);
  else {
    raw?.close();
    await collectInline(
      videoPath, layout, groups, stats, total, onProgress, startSeconds, enough, flush,
    );
  }

  return { groups, stats };
}

export async function decodeVideo(
  videoPath: string,
  outputDir: string,
  onProgress?: (frames: number, total: number | null) => void,
  hint?: Layout,
  /**
   * Decode the video while it is still downloading, finishing when this
   * sentinel path appears. Nothing else changes: groups already went out to
   * disk as the read passed them, and the hash is still checked over all of it
   * before the file takes its name — so a download that dies half way fails
   * here exactly as it would have failed afterwards.
   */
  follow?: string,
): Promise<DecodeStats> {
  // Asked once, before the read, so progress has a denominator. ffprobe on a
  // local file is milliseconds against a decode measured in minutes — but
  // only once the file is done growing. Probing while `follow` is set means
  // the file can still be a handful of bytes with no moov atom yet, and
  // ffprobe does not report that as "unknown", it exits non-zero. A missing
  // total is a bar without a percentage; a crashed probe took the whole
  // decode down with it.
  const total = onProgress && !follow ? (await probe(videoPath)).frames : null;

  // Which grid, before anything else: it decides how much of the video has to
  // be kept on the way in and how many bytes a frame is. The caller can say,
  // and the row that recorded it at encode time is a cheaper answer than the
  // detection pass — but detection stays the fallback, because every video
  // written before the column existed has nothing to say.
  const layout = hint ?? (await detectLayout(videoPath, follow));

  // Groups go out to the file as the read passes them rather than piling up
  // until the end. The old shape held every recovered shard, concatenated them
  // into the whole stream, then gunzipped that into another copy — two or
  // three times the file, which is what stopped a large one being read back at
  // all. `writer` verifies the hash before the file takes its real name, so
  // nothing is handed over unverified.
  const writer = openContainerWriter(outputDir);
  let nextGroup = 0;

  const flush: Flush = async (groups, stats, framesRead) => {
    const finished = Math.floor(framesRead / GROUP_FRAMES) - 1;
    while (nextGroup <= finished) {
      const slots = groups.get(nextGroup);
      if (!slots) throw new Error(`missing entire groups: ${nextGroup}`);
      const shards = await recoverGroup(slots);
      stats.groupsRecovered++;
      for (let i = 0; i < RS_K; i++) await writer.write(shards[i]);
      groups.delete(nextGroup);
      nextGroup++;
    }
  };

  let stats: Counters;
  try {
    const read = await readGroups(
      videoPath,
      layout,
      total,
      onProgress,
      undefined,
      undefined,
      flush,
      follow,
    );
    stats = read.stats;

    if (read.groups.size === 0 && nextGroup === 0) throw new Error('no readable frames found');
    // Whatever the last partial window left behind, counted from the furthest
    // group the frames themselves carried rather than from `framesRead`. The
    // two differ whenever the container holds frames past the payload — a
    // YouTube rendition pads the tail of the video — and rounding the frame
    // count up invented a group that was never encoded, which failed every
    // restore with "missing entire groups: N" for the group after the last.
    await flush(read.groups, stats, (stats.furthestGroup + 1) * GROUP_FRAMES);
  } catch (error) {
    await writer.abort();
    throw error;
  }

  let finished: Awaited<ReturnType<typeof writer.finish>>;
  try {
    finished = await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }

  const { furthestGroup: _furthest, ...counts } = stats;
  return {
    ...counts,
    name: finished.path,
    bytes: finished.bytes,
    sha256: finished.meta.sha256,
    layout: layout.id,
  };
}

export interface RangeStats {
  framesRead: number;
  framesLost: number;
  framesRepaired: number;
  groupsRecovered: number;
  /** First group in the answer, so the caller can map bytes back to the stream. */
  startGroup: number;
  layout: Layout['id'];
}

/**
 * Decodes a run of groups instead of the whole video.
 *
 * The point is a preview: one file out of a bundle is a byte range of the
 * archive, a byte range is a run of groups — `groupBytes` each, laid down in
 * order — and a group is exactly one second of video at 30 frames. So a
 * hundred-megabyte read out of a five-hundred-megabyte bundle is twenty
 * seconds of video rather than six minutes of it.
 *
 * What comes back is raw *stream* bytes, container header included when the
 * range starts at group 0, and no sha256: there is nothing to check a fragment
 * against. Integrity still holds per frame — the CRC32 in every header and the
 * parity across every group — so a bad read is a loud failure here too, just
 * not one that can name the whole file.
 *
 * The frames themselves say which group they belong to, so the seek only has
 * to land somewhere before the range rather than exactly on it.
 */
export async function decodeRange(
  videoPath: string,
  startGroup: number,
  endGroup: number,
  hint?: Layout,
  seek = true,
): Promise<{ bytes: Buffer; stats: RangeStats }> {
  if (startGroup < 0 || endGroup < startGroup) {
    throw new Error(`not a group range: ${startGroup}..${endGroup}`);
  }

  const layout = hint ?? (await detectLayout(videoPath));

  // Back off a couple of seconds before the range. ffmpeg seeks to the
  // keyframe at or before the timestamp, and YouTube's re-encode does not put
  // one on every group boundary the way the master does.
  //
  // `seek` is off when the video is already only the section that holds the
  // range — a `yt-dlp --download-sections` fetch starts its timeline at the
  // cut, not at the start of the original, so a seek measured from group zero
  // would land past everything asked for. A section is seconds long; reading
  // it from the beginning costs nothing.
  const startSeconds = seek
    ? Math.max(0, (startGroup * GROUP_FRAMES) / FPS - SEEK_SAFETY_SECONDS)
    : undefined;

  const { groups, stats } = await readGroups(
    videoPath,
    layout,
    null,
    undefined,
    startSeconds,
    // Past the last group asked for is the only honest stopping point: a group
    // is complete when the read has moved on from it, and a group's frames are
    // contiguous.
    (seen) => seen.furthestGroup > endGroup,
  );

  const parts: Buffer[] = [];
  for (let g = startGroup; g <= endGroup; g++) {
    const slots = groups.get(g);
    if (!slots) {
      // The end of the video is a short answer, not an error: a caller that
      // asks for a window past the last group gets what is there. A missing
      // *first* group is different — nothing was found where the range was
      // said to be, and returning nothing would look like an empty file.
      if (g === startGroup) throw new Error(`group ${g} is not in ${videoPath}`);
      break;
    }
    const shards = await recoverGroup(slots);
    stats.groupsRecovered++;
    for (let i = 0; i < RS_K; i++) parts.push(shards[i]);
  }

  return {
    bytes: Buffer.concat(parts),
    stats: {
      framesRead: stats.framesRead,
      framesLost: stats.framesLost,
      framesRepaired: stats.framesRepaired,
      groupsRecovered: stats.groupsRecovered,
      startGroup,
      layout: layout.id,
    },
  };
}
