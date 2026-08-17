import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodecService, type DecodeResult } from '../codec/codec.service';
import { CookiesExpiredError, YtdlpService } from '../youtube/ytdlp.service';
import { MIN_DECODABLE_HEIGHT } from '../youtube/constants';
import { FilesService } from './files.service';
import { RestoreCache } from './restore-cache';
import { RestoreProgress } from './restore-progress';
import type { StoredFile } from './stored-file.entity';
import { listTar, walkTar, type TarItem } from './tar';

/** Bytes on local disk, and whose job it is to clean up after them. */
export interface RestoredBytes {
  path: string;
  /** Set only when the caller owns scratch — which happens only if the cache refused the file. */
  cleanup?: () => void;
  /**
   * True when the path holds only what was asked for rather than the whole
   * file. A caller that meant to read a range out of an archive has to know
   * which it got: the same bytes are at offset 0 in one and at the entry's
   * offset in the other.
   */
  isSlice?: boolean;
}

/**
 * The heights a restore will try, in order.
 *
 * The smallest rendition every grid is measured readable at comes first, and
 * the best available is the fallback. That order is worth stating plainly: an
 * upload here is 4K, so `bestvideo` means 2160p and roughly four times the
 * bytes of the 1080p rendition — on a measured restore, fourteen of its twenty
 * minutes were the download. `null` means "whatever is best at or above the
 * floor", which is what this did unconditionally before.
 */
const HEIGHTS: (number | null)[] = [MIN_DECODABLE_HEIGHT, null];

/**
 * How "the best rendition available" is written down on a row.
 *
 * Everywhere else that height is `null`, which is also what a row says when
 * nothing has been recorded — and those two must not be the same value. They
 * were, and the cost was exact: `poOMbFOWpgc` does not decode at 1080p, so
 * every read of it downloaded 3.97 GB over eleven minutes and fifty-two
 * seconds, failed, and only then started the download it was always going to
 * need. Zero is not a served height, so it can never collide with a real one.
 */
export const BEST_HEIGHT = 0;

/**
 * The row's stored answer as a height the downloader understands.
 *
 * Three states, and they are three on purpose: a number is that rung, `null` is
 * the best available, and `undefined` is a row nothing has read back yet. The
 * bug this replaces came from having only two.
 */
export function heightFromRow(stored: number | null): number | null | undefined {
  if (stored === null) return undefined;
  return stored === BEST_HEIGHT ? null : stored;
}

/** The inverse: a height as the row stores it. */
export function heightForRow(height: number | null): number {
  return height ?? BEST_HEIGHT;
}

/**
 * Seconds of video a height probe fetches before committing to a full download.
 *
 * Ten seconds is eight groups on the dense grid — enough that a rendition which
 * cannot be read fails here rather than after eleven minutes, and few enough
 * that being wrong costs about twelve seconds. Measured: the section fetch and
 * its decode ran 04:21:02 to 04:21:14 on the live instance.
 */
const PROBE_SECONDS = 10;

/** Groups the probe asks the codec to read out of that section. */
const PROBE_GROUPS = 8;

/**
 * How many groups a verification samples.
 *
 * Each one is its own yt-dlp section fetch, measured at roughly twelve seconds,
 * so eight is about a minute and a half against the fifteen or more a full
 * download costs. The number is a trade and not a discovery: more samples do
 * not make this a proof, they only narrow the gap damage has to hide in.
 */
const SAMPLE_GROUPS = 8;

/** What a sampled verification learned, for the caller to check against the row. */
export interface SampledCheck {
  /** The name the container header carries, which is what the bytes say they are. */
  name: string;
  /**
   * Bytes of *stream*, which is not the file's size when the container gzipped
   * it — the header records what was stored, and nothing anywhere records the
   * original length except the hash. Comparing this to `StoredFile.size`
   * without checking `gzipped` first rejects a perfectly good file: measured on
   * `x6LtjqFWP8Q`, 637,111,296 bytes of tar stored as 636,555,008 compressed.
   */
  payloadLength: number;
  gzipped: boolean;
  /** The payload hash the header claims. Not recomputed here — nothing read all of it. */
  sha256: string;
  groupsChecked: number;
  totalGroups: number;
}

/**
 * `count` group indices spread across `total`, first and last included.
 *
 * Exported for the test: the ends are where a truncated upload and a bad header
 * show up, so an implementation that drifts off them fails quietly rather than
 * loudly.
 */
export function spreadGroups(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, index) => index);

  const picked = new Set<number>([0, total - 1]);
  const step = (total - 1) / (count - 1);
  for (let index = 1; index < count - 1; index++) {
    picked.add(Math.round(index * step));
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * How many groups a partial read fetches when it wants one.
 *
 * A group is a second of video, and the cost of a fetch is mostly its startup
 * — the cookie lock, yt-dlp working out YouTube's `n` parameter, the seek — so
 * asking for one second at a time would pay that over and over. Eight seconds
 * is roughly twelve megabytes of payload on the dense grid: cheap enough to
 * waste, wide enough that walking a tar rarely comes back for the neighbour.
 */
const LOOKAHEAD_GROUPS = 8;

/** Seconds of slack on each side of a fetched section, for a cut that lands on fragments. */
const SECTION_SLACK = 2;

/**
 * Getting a stored file's bytes back, whatever that takes.
 *
 * Split out of the controller because it is the expensive half of this app and
 * three routes need it: a download, a bundle listing, and one entry out of a
 * bundle. Each of those used to start its own restore, so a preview that hit
 * two of them downloaded the same video twice — and the second one waited on
 * the cookie lock until it timed out, then began again. The in-flight map here
 * is what collapses those into one.
 */
@Injectable()
export class RestoreService {
  private readonly log = new Logger(RestoreService.name);

  /**
   * Restores that have started and not finished, by file id.
   *
   * Keyed by file rather than by hash because a hash is what a restore
   * produces, not what identifies it beforehand — an imported row's hash is
   * only a claim until something decodes it.
   */
  private readonly inFlight = new Map<string, Promise<RestoredBytes>>();

  /** The same, for listings — which are their own kind of expensive. */
  private readonly listing = new Map<string, Promise<TarItem[]>>();

  /**
   * Heights the probe has settled, by file id, for the life of the process.
   *
   * Not the database: `restoreHeight` is written only by something that decoded
   * the file, and the next read trusts it without checking. A probe is ten
   * seconds of evidence, which is enough to order the candidates and not enough
   * to be believed outright.
   */
  private readonly probed = new Map<string, { height: number | null }>();

  /** Probes in flight, so two callers arriving together run one. */
  private readonly probing = new Map<string, Promise<number | null | undefined>>();

  constructor(
    private readonly files: FilesService,
    private readonly ytdlp: YtdlpService,
    private readonly codec: CodecService,
    private readonly cache: RestoreCache,
    private readonly restoring: RestoreProgress,
  ) {}

  /**
   * The file's bytes on local disk: the original copy, then the restore cache,
   * then YouTube.
   */
  async bytes(file: StoredFile, fromYoutube: boolean): Promise<RestoredBytes> {
    if (!fromYoutube && file.sourcePath && existsSync(file.sourcePath)) {
      return { path: file.sourcePath };
    }

    if (!file.videoId || !file.ytAccountId) {
      throw new BadRequestException(`file is ${file.status}; nothing to download yet`);
    }

    if (!fromYoutube) {
      const cached = await this.cache.get(file.sha256);
      if (cached) return { path: cached };
    }

    // Everything below this line costs a download and a decode. One at a time
    // per file, and everybody else waits on the same promise rather than
    // starting their own — which is also why the progress map is keyed by file
    // id: the second waiter sees the first one's bar.
    const running = this.inFlight.get(file.id);
    if (running) {
      this.log.log(`joining the restore already running for ${file.id}`);
      return running;
    }

    const started = this.restore(file).finally(() => this.inFlight.delete(file.id));
    this.inFlight.set(file.id, started);
    return started;
  }

  /**
   * Downloads the video and decodes it, trying each height in turn.
   *
   * Verification no longer comes through here — it samples instead, which is
   * most of why storing a file got faster — but the two still have to agree
   * about which rendition to ask for, because the point of verifying is proving
   * that the path a later read will take actually works. `heightOrder` is what
   * they share now.
   */
  async fetchAndDecode(
    file: StoredFile,
    videoPath: string,
    outDir: string,
    onPhase?: (phase: 'downloading' | 'decoding', percent: number | null) => void,
  ): Promise<{ result: DecodeResult; height: number | null }> {
    const heights = await this.heightOrder(file);

    for (const [attempt, height] of heights.entries()) {
      const last = attempt === heights.length - 1;
      try {
        // Each attempt starts its own bar. Without this the percent from the
        // attempt that just finished stays on screen while the next download
        // runs from zero, which is what "stuck at 100%" was.
        onPhase?.('downloading', null);
        await this.ytdlp.download(
          file.ytAccountId!,
          file.videoId!,
          videoPath,
          (percent) => onPhase?.('downloading', percent),
          { height },
        );
        // Said before the codec has a chance to say anything, because it may
        // never get one: a decode over a container with no frame count reports
        // no percentage, and the phase used to be announced only from inside
        // that report. The download's finished bar therefore stayed on screen
        // for the whole decode. The phase is known here regardless of whether a
        // number ever arrives, so here is where it is announced.
        onPhase?.('decoding', null);
        const expected = await this.expectedFrames(file);
        const result = await this.codec.decode(
          videoPath,
          outDir,
          (percent, frames) =>
            onPhase?.(
              'decoding',
              // The codec's own percentage when the container carried a frame
              // count, and one worked out from the file's size when it did not
              // — which for a remuxed download is most of the time, and is why
              // a three-minute decode showed no bar at all.
              percent ?? (expected ? Math.min(100, Math.round((frames / expected) * 100)) : null),
            ),
          file.layout,
        );

        // What worked, and which grid it turned out to be. Both save the next
        // read a wrong guess; neither is ever trusted over what the frames say.
        await this.files.update(file.id, {
          restoreHeight: heightForRow(height),
          layout: result.layout,
        });
        file.restoreHeight = heightForRow(height);
        file.layout = result.layout;

        return { result, height };
      } catch (error) {
        // The last attempt is the one that reports. Anything before it is a
        // rendition that did not decode, which is exactly what the next height
        // is for — and never a reason to lose the file, because the fallback
        // can only ask for more pixels than the attempt that failed.
        if (last) throw error;
        this.log.warn(
          `${file.id} did not come back from a ${height ?? 'best'}p rendition, ` +
            `trying the next height (${(error as Error).message.split('\n')[0]})`,
        );
      }
    }

    throw new Error(`could not restore ${file.id}`);
  }

  /**
   * How many frames a file of this size was written as, or null when the row
   * does not know its own size yet.
   *
   * A denominator that does not depend on the container declaring one. Every
   * group is `groupFrames` frames and carries `groupBytes` of payload, so the
   * file's size is the frame count — and unlike `nb_frames`, a size does not go
   * missing when yt-dlp remuxes the download.
   *
   * Deliberately approximate: gzip means the stored stream is shorter than the
   * row's size, so this over-counts on a compressible file and the bar arrives
   * at 100% a little early. A bar that is slightly conservative is worth more
   * than no bar for three and a half minutes.
   */
  private async expectedFrames(file: StoredFile): Promise<number | null> {
    if (!file.size) return null;
    try {
      const [layout, specs] = await Promise.all([this.codec.layout(file.layout), this.codec.specs()]);
      return Math.ceil(file.size / layout.groupBytes) * specs.groupFrames;
    } catch {
      // A bar is a nicety; failing to draw one must never fail a restore.
      return null;
    }
  }

  /**
   * The heights to try, best guess first.
   *
   * Three sources, in order of what they cost to be wrong about. A height
   * already recorded on the row is free and was proven by a real decode, so it
   * leads. Failing that, ten seconds of video is asked which rung answers,
   * because being wrong about it costs twelve seconds here and eleven minutes
   * further down. Failing that too, the static order stands — the probe is an
   * optimisation and is never allowed to be the reason a restore refuses.
   */
  private async heightOrder(file: StoredFile): Promise<(number | null)[]> {
    const known = heightFromRow(file.restoreHeight);
    if (known !== undefined) {
      return [known, ...HEIGHTS.filter((height) => height !== known)];
    }

    const probed = await this.probeOnce(file);
    if (probed === undefined) return HEIGHTS;
    return [probed, ...HEIGHTS.filter((height) => height !== probed)];
  }

  /**
   * The probe, run at most once per file until something records an answer.
   *
   * Measured on a real read: the bundle listing opened a partial read, spent
   * fifteen seconds discovering 1080p does not decode, gave up — and the
   * restore that followed spent another fourteen discovering the same thing.
   * The row cannot carry the answer between them, because nothing has proven it
   * yet and a guess written there would be trusted absolutely on the next read.
   * Holding it in memory for the life of the process is the middle ground: the
   * second caller gets it free, and a restart forgets it.
   */
  private async probeOnce(file: StoredFile): Promise<number | null | undefined> {
    const remembered = this.probed.get(file.id);
    if (remembered !== undefined) return remembered.height;

    const running = this.probing.get(file.id);
    if (running) return running;

    const started = this.probeHeight(file).finally(() => this.probing.delete(file.id));
    this.probing.set(file.id, started);
    const height = await started;
    if (height !== undefined) this.probed.set(file.id, { height });
    return height;
  }

  /**
   * The first candidate height whose opening seconds actually decode.
   *
   * This is the same trick a partial read already uses — fetch a section, run
   * `decode-range` over it — pointed at a different question. A rendition that
   * cannot give up group 0 will not give up group 4000 either, so ten seconds
   * answers what the whole file was being downloaded to answer.
   *
   * `undefined` means the probe reached no conclusion: every candidate failed,
   * or the section could not be fetched at all. That is not a failure to
   * report, it is a reason to fall back to trying them properly.
   */
  private async probeHeight(file: StoredFile): Promise<number | null | undefined> {
    const specs = await this.codec.specs().catch(() => null);
    if (!specs) return undefined;

    for (const height of HEIGHTS) {
      const dir = await mkdtemp(join(tmpdir(), 'yts-probe-'));
      const videoPath = join(dir, 'probe.mp4');
      const streamPath = join(dir, 'probe.bin');
      const started = Date.now();
      try {
        await this.ytdlp.download(file.ytAccountId!, file.videoId!, videoPath, undefined, {
          height,
          section: { fromSeconds: 0, toSeconds: PROBE_SECONDS },
        });
        await this.codec.decodeRange(videoPath, 0, PROBE_GROUPS - 1, streamPath, file.layout, true);
        this.log.log(
          `${file.id} decodes at ${height ?? 'the best height'} — probed in ` +
            `${Math.round((Date.now() - started) / 1000)}s instead of a whole download`,
        );
        return height;
      } catch (error) {
        // Expired cookies are not a rendition being unreadable, and swallowing
        // them here would send the caller down the full-download path to
        // rediscover the same thing eleven minutes later.
        if (error instanceof CookiesExpiredError) throw error;
        this.log.warn(
          `${file.id} did not decode from ten seconds at ${height ?? 'the best height'} ` +
            `(${(error as Error).message.split('\n')[0]})`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    return undefined;
  }

  /** The whole round trip: download, decode, verify, cache. */
  private async restore(file: StoredFile): Promise<RestoredBytes> {
    // A fresh directory every time. yt-dlp writes the video straight to this
    // path (--no-part), so anything left by an interrupted attempt makes it
    // try to resume a file it has no range for: "HTTP Error 416: Requested
    // range not satisfiable", on every attempt after the first.
    const dir = this.files.workDir('restore', file.id);
    await rm(dir, { recursive: true, force: true });
    await this.files.ensureDir('restore', file.id);

    const videoPath = join(dir, 'download.mp4');
    this.restoring.begin(file.id);
    try {
      const { result } = await this.fetchAndDecode(file, videoPath, dir, (phase, percent) =>
        this.restoring.set(file.id, phase, percent),
      );

      if (file.importedAt) {
        // A row read back off the channel knows only what the description said.
        // The container header is the authority — it is what the bytes actually
        // are — so this is where an imported row stops being a claim. Refusing a
        // mismatch here would refuse the file for disagreeing with its own
        // description, which is the one thing that was never verified.
        await this.files.confirmImported(file, result);
      } else if (result.sha256 !== file.sha256) {
        throw new BadRequestException(`recovered data does not match the stored hash for ${file.name}`);
      }

      // Into the cache before the scratch directory goes, so the next read of
      // these bytes — a download, a listing, one entry — is a file read.
      const cached = await this.cache.put(result.sha256, result.name);
      if (cached) {
        await rm(dir, { recursive: true, force: true });
        return { path: cached };
      }

      return { path: result.name, cleanup: () => void rm(dir, { recursive: true, force: true }) };
    } catch (error) {
      // Leaving the scratch behind is what caused the 416 in the first place.
      await rm(dir, { recursive: true, force: true });
      throw error;
    } finally {
      this.restoring.end(file.id);
    }
  }

  /**
   * Proves YouTube is holding a readable copy, without downloading all of it.
   *
   * Verification used to mean a whole download and a whole decode — a second
   * full round trip per stored file, and on this hardware about half the wall
   * clock of storing anything at all. What that bought over this was a
   * byte-exact hash of the payload; what this buys instead is the container
   * header, whose own CRC has to pass and which carries the payload's length
   * and sha256, plus every sampled group decoding inside its parity budget.
   *
   * The sampling is deliberately not random. Group 0 is where the header lives
   * and the last group is where a truncated upload shows up first; the rest are
   * spread evenly, because the damage this is looking for — a rendition YouTube
   * re-encoded too hard, a transcode that stopped early — is not the kind that
   * hides in one group and leaves its neighbours clean.
   *
   * The honest limit, stated because the caller decides what to do about it:
   * damage confined between two samples passes here and is found on the first
   * real read. Anything that deletes the only other copy on the strength of
   * this needs to know that.
   */
  async sampleFromYoutube(
    file: StoredFile,
    onPhase?: (done: number, total: number) => void,
  ): Promise<SampledCheck> {
    const layout = await this.codec.layout(file.layout);
    // The height first, and cheaply: sampling at a rendition that cannot be
    // read would fail every group and report the file as broken.
    const height = (await this.heightOrder(file))[0];

    const head = await this.fetchGroups(file, 0, 0, height);
    const scratch = await mkdtemp(join(tmpdir(), 'yts-verify-'));
    let header;
    try {
      const path = join(scratch, 'head.bin');
      await writeFile(path, head.subarray(0, Math.min(head.length, 8192)));
      header = await this.codec.header(path);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    const totalGroups = Math.max(
      1,
      Math.ceil((header.payloadOffset + header.payloadLength) / layout.groupBytes),
    );
    const sampled = spreadGroups(totalGroups, SAMPLE_GROUPS);

    onPhase?.(1, sampled.length);
    for (const [index, group] of sampled.entries()) {
      // Group 0 came back above; fetching it twice would be a download for
      // nothing.
      if (group === 0) continue;
      // Throws when the group cannot be rebuilt from what came back — which is
      // the whole check. `decodeRange` already refuses anything outside the
      // parity budget.
      await this.fetchGroups(file, group, group, height);
      onPhase?.(index + 1, sampled.length);
    }

    // Eight groups spread across the video decoding at this height is better
    // evidence than the ten-second probe that chose it, so it is worth writing
    // down: without this the sampling path never records a height — it does not
    // go through `fetchAndDecode`, which is what used to do the recording — and
    // every later read pays the probe again.
    await this.files.update(file.id, { restoreHeight: heightForRow(height) });
    file.restoreHeight = heightForRow(height);

    this.log.log(
      `${file.id} sampled ${sampled.length} of ${totalGroups} groups at ` +
        `${height ?? 'the best height'} — every one decoded`,
    );

    return {
      name: header.name,
      payloadLength: header.payloadLength,
      gzipped: header.gzipped,
      sha256: header.sha256,
      groupsChecked: sampled.length,
      totalGroups,
    };
  }

  /**
   * The listing of a bundle, from wherever it is cheapest.
   *
   * A listing is kilobytes of 512-byte headers spread across the archive, so
   * reading it used to mean restoring the archive. Kept on the row once
   * computed, and read out of the video a few seconds at a time when it is
   * not — which turns "six minutes of video" into "one second per entry".
   */
  async entries(file: StoredFile): Promise<TarItem[]> {
    if (file.entriesJson) return JSON.parse(file.entriesJson) as TarItem[];

    // Deduped like a restore, and for the same reason: the preview sheet asks
    // for the listing and the first entry at once, and a browser reload asks
    // again while the first walk is still fetching.
    const running = this.listing.get(file.id);
    if (running) return running;

    const started = this.walk(file)
      .then(async (items) => {
        const json = JSON.stringify(items);
        await this.files.update(file.id, { entriesJson: json });
        file.entriesJson = json;
        return items;
      })
      .finally(() => this.listing.delete(file.id));

    this.listing.set(file.id, started);
    return started;
  }

  private async walk(file: StoredFile): Promise<TarItem[]> {
    const partial = await this.openPartial(file);
    if (partial) {
      try {
        return await walkTar((offset, length) => partial.read(offset, length), partial.size);
      } catch (error) {
        this.log.warn(
          `partial listing of ${file.id} failed, falling back to a full restore ` +
            `(${(error as Error).message.split('\n')[0]})`,
        );
      }
    }

    const bytes = await this.bytes(file, false);
    try {
      return await listTar(bytes.path);
    } finally {
      bytes.cleanup?.();
    }
  }

  /**
   * One entry of a bundle as bytes on disk, without the rest of the bundle.
   *
   * Falls back to the whole archive whenever a partial read is not on: a
   * gzipped container, an unknown size, a video that will not give up a range.
   */
  async entryBytes(file: StoredFile, item: TarItem): Promise<RestoredBytes> {
    const partial = await this.openPartial(file);
    if (partial && partial.worthFetching(item.offset, item.size)) {
      try {
        const bytes = await partial.read(item.offset, item.size);
        if (bytes.length === item.size) {
          // A temporary directory per request: two people previewing two
          // entries of the same bundle must not write to the same path.
          const dir = await mkdtemp(join(tmpdir(), 'yts-entry-'));
          const path = join(dir, 'entry.bin');
          await writeFile(path, bytes);
          return {
            path,
            isSlice: true,
            cleanup: () => void rm(dir, { recursive: true, force: true }),
          };
        }
      } catch (error) {
        this.log.warn(
          `partial read of ${item.name} failed, falling back to a full restore ` +
            `(${(error as Error).message.split('\n')[0]})`,
        );
      }
    }
    return this.bytes(file, false);
  }

  /**
   * A reader over the payload of a file that is still only on YouTube, or null
   * when nothing can be read that way.
   *
   * Everything it needs comes out of group 0: where the payload starts, how
   * long it is, and whether it is gzipped — which a partial read cannot cope
   * with, because a gzip stream has no middle to start from.
   */
  private async openPartial(file: StoredFile): Promise<PartialReader | null> {
    if (!file.videoId || !file.ytAccountId) return null;
    // A local copy or a cached restore is already cheaper than any of this.
    if (file.sourcePath && existsSync(file.sourcePath)) return null;
    if (await this.cache.get(file.sha256)) return null;

    try {
      const layout = await this.codec.layout(file.layout);
      // Settle the height before reading anything real. Without this the first
      // section fetch assumes the floor, and on a file that does not decode
      // there it spends fifteen seconds finding out — then the restore it falls
      // back to spends fourteen more finding out the same thing. `probeOnce`
      // makes the two share one answer.
      if (heightFromRow(file.restoreHeight) === undefined) await this.probeOnce(file);

      const reader = new PartialReader(
        file,
        layout.groupBytes,
        (start, end) => this.fetchGroups(file, start, end),
        this.cache,
      );
      const header = await reader.header(this.codec);
      if (header.gzipped) {
        this.log.log(`${file.id} is a gzipped container; a partial read cannot start from the middle`);
        return null;
      }
      return reader;
    } catch (error) {
      this.log.warn(`could not open ${file.id} for a partial read: ${(error as Error).message}`);
      return null;
    }
  }

  /** Pulls the seconds of video that hold `start..end` and decodes just them. */
  private async fetchGroups(
    file: StoredFile,
    start: number,
    end: number,
    forceHeight?: number | null,
  ): Promise<Buffer> {
    const specs = await this.codec.specs();
    const secondsPerGroup = specs.groupFrames / specs.fps;
    const dir = await mkdtemp(join(tmpdir(), 'yts-section-'));
    const videoPath = join(dir, 'section.mp4');
    const streamPath = join(dir, 'stream.bin');
    // The caller's height, then the row, then whatever the probe settled this
    // run, then the floor. Through the sentinel and not straight off the row:
    // zero means "the best rendition" here and would reach yt-dlp as
    // `bestvideo[height=0]`, which matches nothing. `??` cannot do the first
    // step — it would fold "best" into the floor, the one height a file storing
    // zero is known not to read at.
    //
    // Consulting the probe matters most for a bundle listing, which reaches
    // this before any restore has run: it used to assume 1080p, spend fifteen
    // seconds failing, and hand the whole archive to a full download.
    const fromRow = heightFromRow(file.restoreHeight);
    const known =
      forceHeight !== undefined
        ? forceHeight
        : fromRow !== undefined
          ? fromRow
          : this.probed.get(file.id)?.height;
    try {
      await this.ytdlp.download(file.ytAccountId!, file.videoId!, videoPath, undefined, {
        height: known === undefined ? MIN_DECODABLE_HEIGHT : known,
        section: {
          fromSeconds: Math.max(0, start * secondsPerGroup - SECTION_SLACK),
          toSeconds: (end + 1) * secondsPerGroup + SECTION_SLACK,
        },
      });
      await this.codec.decodeRange(videoPath, start, end, streamPath, file.layout, true);
      return await readFile(streamPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Random access to the payload of a file that lives on YouTube.
 *
 * Offsets here are into the *payload* — what a tar walker thinks of as the
 * archive — and the container header in front of it is added on the way to a
 * group index. A read fetches whole groups, because a group is the smallest
 * thing the erasure coding can hand back, and keeps them in the restore cache
 * so the next read of a neighbour is free.
 */
class PartialReader {
  private payloadOffset = 0;
  private payloadLength = 0;
  private gzipped = false;
  private loaded = false;

  constructor(
    private readonly file: StoredFile,
    private readonly groupBytes: number,
    private readonly fetch: (start: number, end: number) => Promise<Buffer>,
    private readonly cache: RestoreCache,
  ) {}

  /** The archive's own length, which is what bounds a tar walk. */
  get size(): number {
    return this.payloadLength;
  }

  /**
   * Whether reading this range in pieces actually beats reading all of it.
   *
   * A fetch is one yt-dlp run for a window of groups, so a range that spans
   * most of the file is not a saving but a dozen downloads instead of one —
   * and previewing the 400 MB video inside a 500 MB bundle is exactly that
   * case. Half is the line, and it is deliberately generous: below it the
   * partial path is never much worse, and above it a single download wins.
   */
  worthFetching(offset: number, length: number): boolean {
    const total = Math.ceil((this.payloadOffset + this.payloadLength) / this.groupBytes);
    const from = Math.floor((this.payloadOffset + offset) / this.groupBytes);
    const to = Math.floor((this.payloadOffset + offset + Math.max(0, length - 1)) / this.groupBytes);
    return to - from + 1 <= total / 2;
  }

  async header(codec: CodecService): Promise<{ gzipped: boolean }> {
    if (this.loaded) return { gzipped: this.gzipped };

    // Group 0 holds the header: 48 bytes plus a name, so it cannot straddle a
    // group boundary however long the name is.
    const first = await this.group(0);
    const scratch = await mkdtemp(join(tmpdir(), 'yts-header-'));
    const path = join(scratch, 'head.bin');
    try {
      await writeFile(path, first.subarray(0, Math.min(first.length, 8192)));
      const meta = await codec.header(path);
      this.payloadOffset = meta.payloadOffset;
      this.payloadLength = meta.payloadLength;
      this.gzipped = meta.gzipped;
      this.loaded = true;
      return { gzipped: meta.gzipped };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /** `length` bytes of the payload at `offset`, or fewer at the end of it. */
  async read(offset: number, length: number): Promise<Buffer> {
    const from = this.payloadOffset + offset;
    const to = Math.min(from + length, this.payloadOffset + this.payloadLength);
    if (to <= from) return Buffer.alloc(0);

    const first = Math.floor(from / this.groupBytes);
    const last = Math.floor((to - 1) / this.groupBytes);

    const parts: Buffer[] = [];
    for (let g = first; g <= last; g++) {
      const group = await this.group(g);
      const base = g * this.groupBytes;
      parts.push(group.subarray(Math.max(0, from - base), Math.min(group.length, to - base)));
    }
    return Buffer.concat(parts);
  }

  /**
   * One group, from the cache or from YouTube.
   *
   * A miss fetches a window rather than the single group, and files every
   * group in it: the cost of a fetch is its startup, not its length, and a tar
   * walk asks for the next header a few hundred kilobytes along more often
   * than not.
   */
  private async group(index: number): Promise<Buffer> {
    const cached = await this.cache.getGroup(this.file.sha256, index);
    if (cached) return cached;

    const end = index + LOOKAHEAD_GROUPS - 1;
    const bytes = await this.fetch(index, end);

    for (let g = index; g <= end; g++) {
      const at = (g - index) * this.groupBytes;
      const slice = bytes.subarray(at, at + this.groupBytes);
      if (slice.length === 0) break;
      await this.cache.putGroup(this.file.sha256, g, slice);
    }

    const wanted = bytes.subarray(0, this.groupBytes);
    if (wanted.length === 0) throw new Error(`group ${index} came back empty`);
    return wanted;
  }
}
