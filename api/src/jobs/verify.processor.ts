import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FilesService } from '../files/files.service';
import { RestoreCache } from '../files/restore-cache';
import { RestoreService } from '../files/restore.service';
import { firstLine, YtdlpService } from '../youtube/ytdlp.service';
import { FileJob, VERIFY_QUEUE, verifyBackoff } from './queues';

/**
 * The step that makes the whole thing trustworthy.
 *
 * "Uploaded" is not a guarantee of anything — YouTube re-encodes, and the only
 * proof that the data survived is pulling it back and matching the hash. Local
 * copies are not deleted until that passes, so a bad upload costs nothing.
 *
 * Retries are the normal path here, not an error case: the job re-throws while
 * YouTube is still transcoding, and `verifyBackoff` turns that into a poll that
 * runs every three minutes for an hour and then every quarter of an hour for a
 * day.
 */
@Processor(VERIFY_QUEUE, { concurrency: 1, settings: { backoffStrategy: verifyBackoff } })
export class VerifyProcessor extends WorkerHost {
  private readonly log = new Logger(VerifyProcessor.name);

  constructor(
    private readonly files: FilesService,
    private readonly ytdlp: YtdlpService,
    private readonly restore: RestoreService,
    private readonly cache: RestoreCache,
  ) {
    super();
  }

  async process(job: Job<FileJob>): Promise<void> {
    const file = await this.files.getById(job.data.fileId);
    if (!file.videoId) throw new Error('no video id to verify');
    if (!file.ytAccountId) throw new Error('no account recorded for this upload');

    // No readiness probe. There used to be one, asking yt-dlp in --simulate
    // mode whether a 1080p rendition existed, and it disagreed with the real
    // fetch: the probe reported nothing available for videos that downloaded
    // perfectly a second later. Attempting the download *is* the check — one
    // code path, so the two can never contradict each other. A video still
    // transcoding fails here and the job simply retries.
    const dir = await this.files.ensureDir('verify', file.id);
    const videoPath = join(dir, 'download.mp4');

    try {
      await this.files.update(file.id, {
        verifyAttempts: job.attemptsMade + 1,
        lastCheckedAt: new Date(),
      });
      // The same download-and-decode a restore does, heights and all. Sharing
      // it is the point: verification is the claim that a later read will
      // work, so checking a rendition nobody reads back would prove the wrong
      // thing. It also records which height answered, so the first real
      // restore does not rediscover it.
      //
      // VERIFYING is set inside, not at the top. Setting it before the
      // download meant the row read "verifying" for the whole retry window
      // with a null error, so a file waiting on YouTube looked identical to
      // one being actively checked. Until the video is fetched it is still
      // PROCESSING — which is exactly what the status names say.
      let marked = false;
      const { result } = await this.restore.fetchAndDecode(file, videoPath, dir, (phase) => {
        if (phase !== 'decoding' || marked) return;
        marked = true;
        void this.files.setStatus(file.id, 'VERIFYING');
      });
      if (result.sha256 !== file.sha256) {
        throw new Error(`hash mismatch: stored ${file.sha256}, recovered ${result.sha256}`);
      }

      this.log.log(
        `${file.name} verified - ${result.framesRepaired} frames repaired, ${result.framesLost} rebuilt from parity`,
      );

      // Verification has just decoded the whole file to check its hash, and
      // the next thing anyone does with a file that turns READY is look at it.
      // Handing those bytes to the cache instead of deleting them makes the
      // first preview instant, and costs nothing: they are already on disk.
      await this.cache.put(result.sha256, result.name);

      await this.files.releaseLocalCopies(file);
      await this.files.update(file.id, {
        status: 'READY',
        progress: 100,
        verifiedAt: new Date(),
        error: null,
      });
    } catch (error) {
      // A hash mismatch is final; a transcode that is not ready yet is not.
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`${file.id}: verify attempt ${job.attemptsMade + 1} failed - ${firstLine(error)}`);
      const stillTranscoding = message.includes('still transcoding');

      // Ask YouTube what it *is* serving and record it. Without this the only
      // evidence of a stuck file is the app's own conclusion that YouTube "is
      // still transcoding", which is a guess — and checking it by hand means
      // exporting the cookie jar, which has already destroyed two sessions.
      //
      // Not on every attempt: it is a second yt-dlp call, and doubling the
      // request rate is the last thing to do while rate limiting is still a
      // live hypothesis. The first attempt, every tenth, and the last are
      // enough to tell a capped video from a slow one.
      if (stillTranscoding) {
        const attempt = job.attemptsMade + 1;
        const detail =
          attempt === 1 || attempt % 10 === 0 || this.isLastAttempt(job)
            ? ` - ${await this.describe(file.ytAccountId, file.videoId)}`
            : '';
        await this.files.update(file.id, {
          status: 'PROCESSING',
          error: `${firstLine(error)}${detail}`,
        });
      }

      if (message.includes('hash mismatch') || this.isLastAttempt(job)) {
        await this.files.fail(
          file.id,
          stillTranscoding && this.isLastAttempt(job)
            ? new Error('YouTube never produced a 1080p rendition; local copies kept')
            : error,
        );
      }
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async describe(accountId: string, videoId: string): Promise<string> {
    const formats = await this.ytdlp.describeFormats(accountId, videoId);
    this.log.warn(`${videoId}: ${formats}`);
    return formats;
  }

  /**
   * Without this the row sits in PROCESSING forever once BullMQ gives up: the
   * job is marked failed, but nothing tells the file it will never be retried.
   */
  private isLastAttempt(job: Job<FileJob>): boolean {
    return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  }
}
