import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, join } from 'node:path';
import { FileStatus, StoredFile } from './stored-file.entity';
import { RestoreCache } from './restore-cache';
import { bundleName, toEntries, type UploadedPart } from './bundle';
import { writeTar } from './tar';
import { ENCODE_QUEUE, FileJob, UPLOAD_QUEUE, VERIFY_QUEUE, verifyJobOptions } from '../jobs/queues';
import { AccountsService } from '../accounts/accounts.service';
import { CodecService } from '../codec/codec.service';
import { MAX_VIDEO_SECONDS } from '../youtube/constants';
import { parseContainerVideo, YoutubeService } from '../youtube/youtube.service';

/**
 * How much of a video's theoretical capacity a part is allowed to fill.
 *
 * The container wraps the payload in a header and gzips it, and gzip on bytes
 * that do not compress comes out slightly larger than it went in. Filling the
 * cap exactly would push the last group of a part past it, and past it YouTube
 * throws the entire upload away rather than trimming it.
 */
const PART_MARGIN = 0.97;

/** Pipeline order, least advanced first; a parent shows whichever part is furthest behind. */
const STAGES: FileStatus[] = ['PENDING', 'ENCODING', 'UPLOADING', 'PROCESSING', 'VERIFYING', 'READY'];

/** What a part looks like to the roll-up. Narrow so the test can build one by hand. */
export interface PartState {
  status: FileStatus;
  progress: number;
  error: string | null;
  partIndex: number | null;
}

/**
 * The parent's row, computed from its parts.
 *
 * READY only when every part is: a file missing one part is not a file, and
 * saying otherwise would put a row in the catalogue that cannot be downloaded.
 * FAILED the moment one fails, and naming which one, because the fix is to
 * retry that part rather than the eight gigabytes around it. Otherwise the
 * least advanced stage, so the operator sees the work that is actually left.
 *
 * Exported for the test: this is the only place a split file's state is
 * decided, and getting it wrong is invisible until a download fails.
 */
export function parentState(parts: PartState[]): {
  status: FileStatus;
  error: string | null;
  progress: number;
} {
  const failed = parts.find((part) => part.status === 'FAILED');
  const status: FileStatus = failed
    ? 'FAILED'
    : parts.every((part) => part.status === 'READY')
      ? 'READY'
      : STAGES[Math.min(...parts.map((part) => STAGES.indexOf(part.status)))];

  return {
    status,
    error: failed ? `part ${(failed.partIndex ?? 0) + 1}: ${failed.error ?? 'failed'}` : null,
    // A part that is done is 100 whatever its last reported progress was: the
    // number is per stage, so a READY part can be sitting at whatever percent
    // its verification happened to stop at.
    progress: Math.round(
      parts.reduce((sum, part) => sum + (part.status === 'READY' ? 100 : part.progress), 0) /
        parts.length,
    ),
  };
}

/** What a rebuild found: rows created, rows already here, and what it left alone. */
export interface ImportResult {
  imported: number;
  alreadyKnown: number;
  /** Videos on the channel that are not containers; never adopted, only named. */
  unrecognised: { videoId: string; title: string }[];
  /** True when the channel is longer than one import walks; run it again. */
  truncated: boolean;
}

@Injectable()
export class FilesService {
  private readonly log = new Logger(FilesService.name);
  private readonly dataDir: string;

  constructor(
    @InjectRepository(StoredFile) private readonly files: Repository<StoredFile>,
    config: ConfigService,
    @InjectQueue(ENCODE_QUEUE) private readonly encodeQueue: Queue<FileJob>,
    @InjectQueue(UPLOAD_QUEUE) private readonly uploadQueue: Queue<FileJob>,
    @InjectQueue(VERIFY_QUEUE) private readonly verifyQueue: Queue<FileJob>,
    private readonly cache: RestoreCache,
    private readonly accounts: AccountsService,
    private readonly youtube: YoutubeService,
    private readonly codec: CodecService,
  ) {
    this.dataDir = config.get<string>('DATA_DIR', './data');
  }

  workDir(...parts: string[]): string {
    return join(this.dataDir, ...parts);
  }

  async ingest(userId: string, sourcePath: string, name: string): Promise<StoredFile> {
    const { size } = await stat(sourcePath);
    const sha256 = await this.hash(sourcePath);

    const limit = await this.bytesPerVideo();
    if (size > limit) return this.ingestInParts(userId, sourcePath, name, size, sha256, limit);

    const file = await this.files.save(
      this.files.create({ userId, name, size, sha256, sourcePath, status: 'PENDING' }),
    );

    await this.encodeQueue.add('encode', { fileId: file.id }, { jobId: file.id });
    this.log.log(`queued ${name} (${size} bytes)`);
    return file;
  }

  /**
   * The most payload one video can carry, in bytes.
   *
   * A group is one second of video and `groupBytes` of data, so the channel's
   * length cap is really a size cap — and the arithmetic has to come from the
   * codec rather than a constant here, because the grid that writes decides how
   * much a second holds.
   *
   * The margin is for the container: the payload is wrapped in a header and
   * then gzipped, and gzip on already-compressed bytes is slightly *larger*
   * than what went in. Cutting at the theoretical maximum would put the last
   * group of a part past the cap by a frame or two, which YouTube answers by
   * throwing the whole upload away.
   */
  private async bytesPerVideo(): Promise<number> {
    // The grid the encoder *writes* with, which is not what `layout(null)`
    // answers: null means "a video that predates the column", and its fallback
    // is the wide grid every one of those used. Asking that way cut a 2 GiB
    // file into seven parts of 335 MB instead of two of 1.3 GB — correct, and
    // six uploads more than the file needed.
    const specs = await this.codec.specs();
    const writing = specs.layouts.find((layout) => layout.id === specs.writing);
    if (!writing) throw new Error(`the codec writes with ${specs.writing}, which it did not describe`);
    return Math.floor(MAX_VIDEO_SECONDS * writing.groupBytes * PART_MARGIN);
  }

  /**
   * Stores a file too long for one video as a parent row plus a run of parts.
   *
   * The split is on the payload, before the container: each part is a plain
   * byte range of the original and becomes an ordinary stored file with its own
   * header, hash, video, verification and retry. That is the whole reason to
   * cut here rather than inside the codec — nothing downstream needs to learn
   * about parts, and a part that fails is one part to redo rather than eight
   * gigabytes.
   *
   * The parent holds the name, the size and the hash of the whole file and owns
   * no video. Its status is rolled up from the parts by `syncParent`.
   */
  private async ingestInParts(
    userId: string,
    sourcePath: string,
    name: string,
    size: number,
    sha256: string,
    limit: number,
  ): Promise<StoredFile> {
    const count = Math.ceil(size / limit);
    const parent = await this.files.save(
      this.files.create({ userId, name, size, sha256, sourcePath: null, status: 'PENDING' }),
    );

    const dir = await this.ensureDir('incoming');
    this.log.log(
      `${name} is ${size} bytes, past the ${limit} one video can carry - splitting into ${count} parts`,
    );

    try {
      for (let index = 0; index < count; index++) {
        const start = index * limit;
        const end = Math.min(start + limit, size) - 1;
        const partPath = join(dir, `${randomUUID()}.part`);
        await pipeline(createReadStream(sourcePath, { start, end }), createWriteStream(partPath));

        const part = await this.files.save(
          this.files.create({
            userId,
            parentId: parent.id,
            partIndex: index,
            // Named so the channel and the logs say what it is. The parent's
            // name is what the operator ever sees.
            name: `${name}.part${index + 1}of${count}`,
            size: end - start + 1,
            sha256: await this.hash(partPath),
            sourcePath: partPath,
            status: 'PENDING',
          }),
        );
        await this.encodeQueue.add('encode', { fileId: part.id }, { jobId: part.id });
      }
    } catch (error) {
      // A half-split file is worse than none: the parts already queued would
      // upload and the file could never be reassembled. Take the whole thing
      // down and let the operator upload it again.
      await this.remove(userId, parent.id).catch(() => undefined);
      throw error;
    } finally {
      // The parts hold every byte, so the original is scratch from here on.
      await rm(sourcePath, { force: true });
    }

    this.log.log(`queued ${name} as ${count} parts`);
    return parent;
  }

  /** The parts of a file, in the order they have to be joined. */
  partsOf(parentId: string): Promise<StoredFile[]> {
    return this.files.find({ where: { parentId }, order: { partIndex: 'ASC' } });
  }

  /**
   * Renames a stored file, on the channel as well as here.
   *
   * The database is the name of record and is updated first, so a rename never
   * half-fails: whatever YouTube says afterwards, the file is called what the
   * operator called it. The videos are then retitled to match — one per part,
   * numbered `p1`, `p2` — because a channel where every video is a UUID is
   * unreadable to the person who owns it, and because the description is what
   * a rebuild reads back, so leaving it stale would resurrect the old name the
   * first time the catalogue is rebuilt.
   *
   * A video that refuses is reported, not thrown: an account connected before
   * the write scope existed can still store and restore files perfectly, and
   * the only thing it cannot do is this cosmetic half. The return says which
   * ones were left behind so the UI can say "reconnect the account".
   */
  async rename(userId: string, id: string, name: string): Promise<{ file: StoredFile; stale: number }> {
    const clean = name.trim();
    if (!clean) throw new BadRequestException('a name cannot be empty');
    if (clean.length > 200) throw new BadRequestException('that name is too long');
    // Path separators would let a name escape the directory it is served from,
    // and the name is used to build the download's filename.
    if (/[/\\]|^\.+$/.test(clean)) throw new BadRequestException('a name cannot contain / or \\');

    const file = await this.get(userId, id);
    const parts = await this.partsOf(file.id);

    await this.files.update(file.id, { name: clean });
    for (const part of parts) {
      await this.files.update(part.id, { name: `${clean}.part${part.partIndex! + 1}of${parts.length}` });
    }

    // The videos to retitle: a whole file owns one, a parent owns none of its
    // own and every one of its parts'.
    const videos = (parts.length > 0 ? parts : [file]).map((row, index) => ({
      row,
      part: parts.length > 0 ? { index, count: parts.length } : undefined,
    }));

    let stale = 0;
    for (const { row, part } of videos) {
      if (!row.videoId || !row.ytAccountId) continue;
      try {
        const account = await this.accounts.loadSecretById(row.ytAccountId);
        await this.youtube.retitle(account, row.videoId, {
          fileId: row.id,
          name: clean,
          sha256: row.sha256,
          part,
        });
      } catch (error) {
        stale++;
        this.log.warn(`could not retitle ${row.videoId}: ${(error as Error).message}`);
      }
    }

    this.log.log(`renamed ${file.name} to ${clean}${stale ? ` (${stale} videos left stale)` : ''}`);
    return { file: await this.getById(file.id), stale };
  }

  /**
   * Rolls a part's state up into the row the operator is watching.
   *
   * The parent has no work of its own, so its status is whatever its parts say
   * together: the least advanced stage while they are working, FAILED the
   * moment one fails — a file missing a part is not a file — and READY only
   * when every one of them is.
   */
  private async syncParent(parentId: string): Promise<void> {
    const parts = await this.partsOf(parentId);
    if (parts.length === 0) return;

    const state = parentState(parts);
    await this.files.update(parentId, {
      ...state,
      ...(state.status === 'READY' ? { verifiedAt: new Date() } : {}),
    });
  }

  /**
   * Writes several uploaded parts into one tar and ingests that.
   *
   * The archive is built in the incoming directory and the parts are deleted
   * once it exists, so a failure half way leaves scratch behind rather than a
   * half-formed file in the catalogue.
   */
  async ingestBundle(
    userId: string,
    uploads: UploadedPart[],
    requestedName?: string,
  ): Promise<StoredFile> {
    const entries = toEntries(uploads);
    const name = bundleName(
      entries.map((entry) => entry.name),
      requestedName,
    );

    const dir = await this.ensureDir('incoming');
    const tarPath = join(dir, `${randomUUID()}.tar`);

    try {
      await writeTar(entries, tarPath);
    } catch (error) {
      await rm(tarPath, { force: true });
      throw error;
    } finally {
      for (const upload of uploads) await rm(upload.path, { force: true });
    }

    this.log.log(`bundled ${entries.length} files into ${name}`);
    return this.ingest(userId, tarPath, name);
  }

  /**
   * Rebuilds the catalogue from the channel: every container video that has no
   * row here gets one.
   *
   * The point of the exercise is that the videos outlive this database. Each
   * upload writes the filename and the hash into its description precisely so
   * that a lost, replaced or simply *different* SQLite file is a recoverable
   * state rather than a channel of unidentifiable videos — which is what this
   * reads back.
   *
   * Nothing is downloaded. The description is enough to name a row and enough
   * to find it again; the original size and the real hash only exist inside the
   * video, and the first download decodes it anyway. So the row lands marked
   * `importedAt` and the restore path settles it — see `bytesOf`.
   *
   * Videos that are not ours are reported, never adopted. Guessing at a video
   * whose description does not match would store a hash that the decode later
   * refuses, turning someone else's holiday clip into a permanently broken row.
   */
  async importFromChannel(userId: string, accountId: string): Promise<ImportResult> {
    const account = await this.accounts.loadSecret(userId, accountId);
    const { videos, playlistId, truncated } = await this.youtube.listUploads(
      account,
      account.uploadsPlaylistId,
    );

    if (playlistId !== account.uploadsPlaylistId) {
      await this.accounts.rememberUploadsPlaylist(account.id, playlistId);
    }

    // One query rather than one per video: a channel is thousands of rows at
    // most and the catalogue is already loaded whole by every listing.
    const known = new Set(
      (await this.files.find({ where: { userId }, select: { videoId: true } }))
        .map((file) => file.videoId)
        .filter((videoId): videoId is string => videoId !== null),
    );

    const unrecognised: { videoId: string; title: string }[] = [];
    const rows: StoredFile[] = [];

    for (const video of videos) {
      const container = parseContainerVideo(video);
      if (!container) {
        unrecognised.push({ videoId: video.videoId, title: video.title });
        continue;
      }
      if (known.has(video.videoId)) continue;

      rows.push(
        this.files.create({
          userId,
          ytAccountId: account.id,
          videoId: video.videoId,
          name: container.name,
          sha256: container.sha256,
          // Unknown until something decodes the video; null says so honestly.
          size: null,
          status: 'READY',
          importedAt: new Date(),
          // The bytes are on YouTube and nowhere else, which is exactly the
          // state a verified file ends in.
          verifiedAt: video.publishedAt ? new Date(video.publishedAt) : new Date(),
        }),
      );
    }

    if (rows.length) await this.files.save(rows);
    this.log.log(
      `imported ${rows.length} files from ${account.label}` +
        ` (${videos.length} videos on the channel, ${unrecognised.length} not ours)`,
    );

    return {
      imported: rows.length,
      alreadyKnown: videos.length - rows.length - unrecognised.length,
      unrecognised,
      truncated,
    };
  }

  /**
   * Replaces an imported row's claims with what the video actually contained.
   *
   * The description could always have been edited, truncated by YouTube, or
   * simply written by an older version of this app. The container header could
   * not: it travels inside the pixels with the data it describes. So the first
   * decode is the moment the row stops being a reading of a description and
   * becomes a measurement — and `importedAt` clearing is what says so.
   *
   * `decoded.name` is the path the codec wrote, not a filename.
   */
  async confirmImported(
    file: StoredFile,
    decoded: { name: string; bytes: number; sha256: string },
  ): Promise<void> {
    const name = basename(decoded.name);
    const changed = name !== file.name || decoded.sha256 !== file.sha256;

    file.name = name;
    file.size = decoded.bytes;
    file.sha256 = decoded.sha256;
    file.importedAt = null;
    file.verifiedAt = file.verifiedAt ?? new Date();

    await this.files.update(file.id, {
      name,
      size: decoded.bytes,
      sha256: decoded.sha256,
      importedAt: null,
      verifiedAt: file.verifiedAt,
    });

    this.log.log(
      changed
        ? `confirmed imported ${file.id}: it is ${name} (${decoded.bytes} bytes), not what its description said`
        : `confirmed imported ${file.id}: ${name}, ${decoded.bytes} bytes`,
    );
  }

  hash(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(path)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  /** Whole files and parents only: a part is an implementation detail of one row. */
  list(userId: string): Promise<StoredFile[]> {
    return this.files.find({
      where: { userId, parentId: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /** Scoped by user so no route can read another account's catalogue. */
  async get(userId: string, id: string): Promise<StoredFile> {
    const file = await this.files.findOne({ where: { id, userId } });
    if (!file) throw new NotFoundException(`no file ${id}`);
    return file;
  }

  /** Worker-side lookup: jobs carry an id and are trusted to be internal. */
  async getById(id: string): Promise<StoredFile> {
    const file = await this.files.findOne({ where: { id } });
    if (!file) throw new NotFoundException(`no file ${id}`);
    return file;
  }

  async update(id: string, data: Partial<StoredFile>): Promise<void> {
    await this.files.update(id, data);
    await this.rollUp(id);
  }

  async setStatus(id: string, status: FileStatus, progress = 0): Promise<void> {
    await this.files.update(id, { status, progress, error: null });
    await this.rollUp(id);
  }

  async fail(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error(`file ${id} failed: ${message}`);
    await this.files.update(id, { status: 'FAILED', error: message });
    await this.rollUp(id);
  }

  /**
   * Every write to a row goes through `update`, `setStatus` or `fail`, so this
   * is the one place a part's parent has to be told anything. A whole file has
   * no parent and pays a single indexed lookup for the privilege.
   */
  private async rollUp(id: string): Promise<void> {
    const row = await this.files.findOne({ where: { id }, select: { parentId: true } });
    if (row?.parentId) await this.syncParent(row.parentId);
  }

  async ensureDir(...parts: string[]): Promise<string> {
    const dir = this.workDir(...parts);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Drops the local copies once YouTube has been proven to hold a readable
   * version. Called only from the verify step — deleting earlier would mean
   * trusting an upload nobody has read back yet.
   */
  async releaseLocalCopies(file: StoredFile): Promise<void> {
    for (const path of [file.sourcePath, file.videoPath]) {
      if (path) await rm(path, { force: true });
    }
    await this.files.update(file.id, { sourcePath: null, videoPath: null });
  }

  /**
   * Puts a failed file back on the queue it stopped at.
   *
   * Most failures here are not the file's fault — the day's upload quota ran
   * out, YouTube was unreachable, the worker was killed. Without this the only
   * way forward is to upload the bytes again and pay for the encode a second
   * time, when both the original and the encoded video are usually still on
   * disk. Routing is by artifact rather than by status, exactly as
   * `ReconcileService` does it on boot: whatever exists decides where it goes.
   */
  async retry(userId: string, id: string): Promise<StoredFile> {
    const file = await this.get(userId, id);
    if (file.status !== 'FAILED') {
      throw new BadRequestException(`${file.name} is ${file.status}, not failed`);
    }

    // A parent has no work of its own: retrying it means retrying whichever of
    // its parts stopped, and leaving the ones that are already stored alone.
    const parts = await this.partsOf(file.id);
    if (parts.length > 0) {
      for (const part of parts) {
        if (part.status === 'FAILED') await this.retry(userId, part.id);
      }
      await this.syncParent(file.id);
      return this.getById(file.id);
    }

    const target = file.videoId
      ? { queue: this.verifyQueue, name: 'verify', options: verifyJobOptions(file.id), status: 'PROCESSING' as const }
      : file.videoPath && existsSync(file.videoPath)
        ? { queue: this.uploadQueue, name: 'upload', options: { jobId: file.id }, status: 'UPLOADING' as const }
        : file.sourcePath && existsSync(file.sourcePath)
          ? { queue: this.encodeQueue, name: 'encode', options: { jobId: file.id }, status: 'PENDING' as const }
          : null;

    if (!target) throw new BadRequestException('nothing left on disk to resume from; upload it again');

    // Jobs are keyed by the file id, so the failed one from last time has to be
    // dealt with explicitly: adding on top of it is silently deduplicated.
    const existing = await target.queue.getJob(file.id);
    if (existing) await existing.remove().catch(() => undefined);

    await this.files.update(file.id, { status: target.status, error: null, progress: 0 });
    await target.queue.add(target.name, { fileId: file.id }, target.options);
    this.log.log(`retrying ${file.name} from ${target.name}`);

    return this.getById(file.id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const file = await this.get(userId, id);

    // A parent's parts are not reachable from any route, so deleting the row
    // the operator sees has to take them with it or they become orphans that
    // nothing lists and nothing can remove.
    for (const part of await this.partsOf(file.id)) {
      await this.remove(userId, part.id);
    }

    for (const path of [file.sourcePath, file.videoPath]) {
      if (path) await rm(path, { force: true });
    }
    // The restored bytes go too. Keeping them would leave a file the user
    // deleted sitting on disk, readable by the next request that happens to
    // ask for the same hash.
    await this.cache.forget(file.sha256);
    await this.files.delete({ id, userId });
  }

  /** Newest verified file for an account, used as the cookie health probe. */
  probeFor(ytAccountId: string): Promise<StoredFile | null> {
    return this.files.findOne({
      where: { ytAccountId, status: 'READY' },
      order: { verifiedAt: 'DESC' },
    });
  }

  countByStatus(userId: string): Promise<{ status: FileStatus; count: string }[]> {
    return this.files
      .createQueryBuilder('file')
      .select('file.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('file.userId = :userId', { userId })
      .groupBy('file.status')
      .getRawMany();
  }
}
