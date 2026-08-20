import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { rm } from 'node:fs/promises';
import { FilesService } from '../files/files.service';
import { RestoreCache } from '../files/restore-cache';
import { RestoreService, type SampledCheck } from '../files/restore.service';
import type { StoredFile } from '../files/stored-file.entity';
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
    // perfectly a second later. Attempting the fetch *is* the check — one code
    // path, so the two can never contradict each other. A video still
    // transcoding fails here and the job simply retries.
    const dir = await this.files.ensureDir('verify', file.id);

    try {
      await this.files.update(file.id, {
        verifyAttempts: job.attemptsMade + 1,
        lastCheckedAt: new Date(),
      });
      // Sampled rather than exhaustive, and through the same section-fetch path
      // a bundle preview uses — so what is being checked is still the path a
      // later read will take, which was always the point of verifying. It also
      // resolves which height answers and leaves that on the row, so the first
      // real restore does not rediscover it.
      //
      // VERIFYING is set inside, not at the top. Setting it before the
      // download meant the row read "verifying" for the whole retry window
      // with a null error, so a file waiting on YouTube looked identical to
      // one being actively checked. Until the video is fetched it is still
      // PROCESSING — which is exactly what the status names say.
      let marked = false;
      const check = await this.restore.sampleFromYoutube(file, (done) => {
        if (done < 1 || marked) return;
        marked = true;
        void this.files.setStatus(file.id, 'VERIFYING');
      });

      const disagreement = headerDisagreesWith(file, check);
      if (disagreement) throw new Error(disagreement);

      this.log.log(
        `${file.name} verified - ${check.groupsChecked} of ${check.totalGroups} groups sampled, ` +
          'header hash and length agree',
      );

      // The local copy is about to be released, and the next thing anyone does
      // with a file that turns READY is look at it. Handing those bytes to the
      // cache first is what keeps the first preview instant now that
      // verification no longer decodes the whole file to hand over.
      if (file.sourcePath) {
        await this.cache.put(file.sha256, file.sourcePath).catch(() => undefined);
      }

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

      // An incomplete upload is as final as a hash mismatch: the groups are not
      // on YouTube, so waiting a day for a transcode that has already finished
      // only delays the news. The local copies are kept by `fail`, which is
      // what makes the file recoverable by uploading it again.
      //
      // So is a video YouTube has taken down. Measured on `71BoJ-0cBk0`, which
      // was over the channel's length cap: yt-dlp answers "Video unavailable.
      // This video was removed because it was too long" on every attempt, and
      // retrying that for a day is a day of asking a deleted video to appear.
      if (
        message.includes('hash mismatch') ||
        message.includes('incomplete upload') ||
        message.includes('Video unavailable') ||
        this.isLastAttempt(job)
      ) {
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

/**
 * Whether what the container header says contradicts what the row claims.
 *
 * Returns the complaint, or null when the two agree. Split out of the processor
 * because getting it wrong is expensive in a specific way — it rejects a file
 * that is perfectly recoverable — and because that is exactly what happened:
 * comparing `payloadLength` to `size` refused `x6LtjqFWP8Q` after all eight
 * sampled groups had decoded and the hash had already matched.
 *
 * The hash is the check that carries the weight. It is taken over the original
 * bytes before the container ever compresses them, so it is the only thing that
 * survives gzip unchanged — and, conveniently, the only thing an attacker or a
 * bad transcode cannot forge past a CRC-protected header.
 */
export function headerDisagreesWith(
  file: Pick<StoredFile, 'sha256' | 'size'>,
  check: SampledCheck,
): string | null {
  if (check.sha256 !== file.sha256) {
    return `hash mismatch: stored ${file.sha256}, container says ${check.sha256}`;
  }

  // Only when the container stored the bytes as they came. `payloadLength` is
  // the length of the *stream*: for a gzipped container that is the compressed
  // size and the row's is not. Nothing records the original length except the
  // hash, which has already been checked above.
  if (file.size && !check.gzipped && check.payloadLength !== file.size) {
    return `length mismatch: stored ${file.size} bytes, container says ${check.payloadLength}`;
  }

  return null;
}
