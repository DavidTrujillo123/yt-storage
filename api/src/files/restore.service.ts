import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodecService, type DecodeResult } from '../codec/codec.service';
import { YtdlpService } from '../youtube/ytdlp.service';
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
   * Public because verification runs the same round trip for a different
   * reason, and the two must not disagree about which rendition a restore
   * uses: the point of verifying is proving that the path a later read will
   * take actually works.
   */
  async fetchAndDecode(
    file: StoredFile,
    videoPath: string,
    outDir: string,
    onPhase?: (phase: 'downloading' | 'decoding', percent: number | null) => void,
  ): Promise<{ result: DecodeResult; height: number | null }> {
    // The height that worked last time first, then the rest. A file that
    // genuinely needs 2160p should pay for the discovery once.
    const heights = file.restoreHeight
      ? [file.restoreHeight, ...HEIGHTS.filter((h) => h !== file.restoreHeight)]
      : HEIGHTS;

    for (const [attempt, height] of heights.entries()) {
      const last = attempt === heights.length - 1;
      try {
        await this.ytdlp.download(
          file.ytAccountId!,
          file.videoId!,
          videoPath,
          (percent) => onPhase?.('downloading', percent),
          { height },
        );
        const result = await this.codec.decode(
          videoPath,
          outDir,
          (percent) => onPhase?.('decoding', percent),
          file.layout,
        );

        // What worked, and which grid it turned out to be. Both save the next
        // read a wrong guess; neither is ever trusted over what the frames say.
        await this.files.update(file.id, { restoreHeight: height, layout: result.layout });
        file.restoreHeight = height;
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
  private async fetchGroups(file: StoredFile, start: number, end: number): Promise<Buffer> {
    const specs = await this.codec.specs();
    const secondsPerGroup = specs.groupFrames / specs.fps;
    const dir = await mkdtemp(join(tmpdir(), 'yts-section-'));
    const videoPath = join(dir, 'section.mp4');
    const streamPath = join(dir, 'stream.bin');
    try {
      await this.ytdlp.download(file.ytAccountId!, file.videoId!, videoPath, undefined, {
        height: file.restoreHeight ?? MIN_DECODABLE_HEIGHT,
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
