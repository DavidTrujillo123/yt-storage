import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { FilesService } from '../files/files.service';
import { AccountsService } from '../accounts/accounts.service';
import { YoutubeService } from '../youtube/youtube.service';
import { FileJob, UPLOAD_QUEUE, VERIFY_QUEUE, verifyJobOptions } from './queues';

/**
 * Concurrency is 1 and there is no retry storm on purpose: every videos.insert
 * spends one of an account's hundred uploads for the day, so a blind retry
 * loop burns the whole allowance in minutes.
 */
@Processor(UPLOAD_QUEUE, { concurrency: 1 })
export class UploadProcessor extends WorkerHost {
  private readonly log = new Logger(UploadProcessor.name);

  constructor(
    private readonly files: FilesService,
    private readonly accounts: AccountsService,
    private readonly youtube: YoutubeService,
    @InjectQueue(VERIFY_QUEUE) private readonly verifyQueue: Queue<FileJob>,
  ) {
    super();
  }

  async process(job: Job<FileJob>): Promise<void> {
    const file = await this.files.getById(job.data.fileId);
    if (!file.videoPath) throw new Error('encoded video is missing');
    if (file.videoId) {
      this.log.warn(`${file.id} already has video ${file.videoId}, skipping upload`);
      return;
    }

    try {
      await this.files.setStatus(file.id, 'UPLOADING');

      // Chosen at upload time rather than at ingest: an account can run out of
      // quota, lose its cookies, or be deleted while the file sits in the queue.
      const account = await this.accounts.pickForUpload(file.userId);

      const videoId = await this.youtube.upload(
        account,
        file.videoPath,
        { fileId: file.id, name: file.name, sha256: file.sha256 },
        (percent) => void this.files.update(file.id, { progress: percent }),
      );

      await this.files.update(file.id, {
        videoId,
        ytAccountId: account.id,
        status: 'PROCESSING',
        progress: 0,
      });

      // YouTube needs time to produce a 1080p rendition; the first check is
      // deliberately late rather than immediate.
      await this.verifyQueue.add('verify', { fileId: file.id }, verifyJobOptions(file.id));
    } catch (error) {
      await this.files.fail(file.id, error);
      throw error;
    }
  }
}
