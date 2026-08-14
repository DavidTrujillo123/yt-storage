import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { rm } from 'node:fs/promises';
import { StoredFile } from '../files/stored-file.entity';
import { FilesService } from '../files/files.service';
import { ENCODE_QUEUE, FileJob, UPLOAD_QUEUE, VERIFY_QUEUE, verifyJobOptions } from './queues';

/**
 * Picks the pipeline back up after a crash or a restart.
 *
 * A worker killed mid-encode leaves its row stuck in ENCODING forever: the
 * BullMQ job is gone, nothing will ever retry it, and the file silently never
 * arrives. On boot every non-terminal row is matched back to the queue it
 * belongs in and re-enqueued.
 *
 * Safe to run repeatedly — jobs are keyed by file id, and each processor
 * already skips work that is done (an upload with a videoId returns early).
 */
@Injectable()
export class ReconcileService implements OnApplicationBootstrap {
  private readonly log = new Logger(ReconcileService.name);

  constructor(
    @InjectRepository(StoredFile) private readonly files: Repository<StoredFile>,
    private readonly filesService: FilesService,
    @InjectQueue(ENCODE_QUEUE) private readonly encodeQueue: Queue<FileJob>,
    @InjectQueue(UPLOAD_QUEUE) private readonly uploadQueue: Queue<FileJob>,
    @InjectQueue(VERIFY_QUEUE) private readonly verifyQueue: Queue<FileJob>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.clearScratchDirs();
    await this.requeueOrphans();
  }

  /** Half-finished verify and restore downloads are never worth keeping. */
  private async clearScratchDirs(): Promise<void> {
    for (const dir of ['verify', 'restore']) {
      await rm(this.filesService.workDir(dir), { recursive: true, force: true });
    }
  }

  private async requeueOrphans(): Promise<void> {
    const stuck = await this.files.find({
      where: { status: In(['PENDING', 'ENCODING', 'UPLOADING', 'PROCESSING', 'VERIFYING']) },
    });
    if (stuck.length === 0) return;

    let requeued = 0;
    for (const file of stuck) {
      const target = this.queueFor(file);
      if (!target) {
        await this.filesService.fail(file.id, new Error('no local copy left to resume from'));
        continue;
      }

      // Jobs are keyed by file id, so a leftover from the previous run must be
      // dealt with explicitly: adding on top of it is silently deduplicated,
      // which leaves the old job sitting on whatever backoff it had reached.
      const existing = await target.queue.getJob(file.id);
      if (existing) {
        const state = await existing.getState();

        // Already running, or about to: leave it alone.
        if (state === 'active' || state === 'waiting') continue;

        // A restart should mean "try again now", not "keep waiting an hour".
        if (state === 'delayed') {
          await existing.promote().catch(() => undefined);
          requeued++;
          continue;
        }
        await existing.remove().catch(() => undefined);
      }

      await target.queue.add(target.name, { fileId: file.id }, target.options);
      requeued++;
    }

    this.log.log(`re-queued ${requeued} of ${stuck.length} interrupted file(s)`);
  }

  private queueFor(file: StoredFile) {
    if (file.videoId) {
      return { queue: this.verifyQueue, name: 'verify', options: verifyJobOptions(file.id) };
    }
    if (file.videoPath) {
      return { queue: this.uploadQueue, name: 'upload', options: { jobId: file.id } };
    }
    if (file.sourcePath) {
      return { queue: this.encodeQueue, name: 'encode', options: { jobId: file.id } };
    }
    return null;
  }
}
