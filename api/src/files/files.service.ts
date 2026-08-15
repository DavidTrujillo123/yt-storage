import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FileStatus, StoredFile } from './stored-file.entity';
import { RestoreCache } from './restore-cache';
import { bundleName, toEntries, type UploadedPart } from './bundle';
import { writeTar } from './tar';
import { ENCODE_QUEUE, FileJob, UPLOAD_QUEUE, VERIFY_QUEUE, verifyJobOptions } from '../jobs/queues';
import { AccountsService } from '../accounts/accounts.service';
import { parseContainerVideo, YoutubeService } from '../youtube/youtube.service';

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
  ) {
    this.dataDir = config.get<string>('DATA_DIR', './data');
  }

  workDir(...parts: string[]): string {
    return join(this.dataDir, ...parts);
  }

  async ingest(userId: string, sourcePath: string, name: string): Promise<StoredFile> {
    const { size } = await stat(sourcePath);
    const sha256 = await this.hash(sourcePath);

    const file = await this.files.save(
      this.files.create({ userId, name, size, sha256, sourcePath, status: 'PENDING' }),
    );

    await this.encodeQueue.add('encode', { fileId: file.id }, { jobId: file.id });
    this.log.log(`queued ${name} (${size} bytes)`);
    return file;
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

  list(userId: string): Promise<StoredFile[]> {
    return this.files.find({ where: { userId }, order: { createdAt: 'DESC' } });
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
  }

  async setStatus(id: string, status: FileStatus, progress = 0): Promise<void> {
    await this.files.update(id, { status, progress, error: null });
  }

  async fail(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error(`file ${id} failed: ${message}`);
    await this.files.update(id, { status: 'FAILED', error: message });
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
