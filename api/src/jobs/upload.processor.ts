import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { FilesService } from '../files/files.service';
import { AccountsService } from '../accounts/accounts.service';
import { YoutubeService } from '../youtube/youtube.service';
import { UNVERIFIED_MAX_VIDEO_SECONDS, VERIFIED_MAX_VIDEO_SECONDS } from '../youtube/constants';
import { FileJob, UPLOAD_QUEUE, VERIFY_QUEUE, verifyJobOptions } from './queues';

/** One group is one second of video; the codec's own frame rate, not a guess. */
const FPS = 30;

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

      // Before a byte goes up, and against the cap of the channel actually
      // receiving it: past that cap `videos.insert` still succeeds and YouTube
      // quietly abandons the transcode, which costs one of the day's uploads,
      // ten gigabytes of bandwidth and — worst of all — leaves a video id on
      // the row that makes the file look stored. Checked here rather than at
      // ingest because which account takes the file is only known now.
      const tooLong = tooLongForYoutube(file.frames, account.verified);
      if (tooLong) {
        await this.files.fail(file.id, new Error(tooLong));
        return;
      }

      // A part carries its position so the channel reads `Cursos Virtuales p1`,
      // `p2`, and so a rebuild from the channel alone can put the pieces back
      // in order. The name on a part row already ends in `.partNofM`; the
      // parent's plain name is what belongs on the video.
      const part = file.parentId
        ? {
            index: file.partIndex ?? 0,
            count: (await this.files.partsOf(file.parentId)).length,
          }
        : undefined;
      const parent = file.parentId ? await this.files.getById(file.parentId) : null;

      const videoId = await this.youtube.upload(
        account,
        file.videoPath,
        { fileId: file.id, name: parent?.name ?? file.name, sha256: file.sha256, part },
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

/**
 * The complaint when a video would be longer than the channel accepts, or null.
 *
 * `frames` is what the encode actually wrote, so this is exact rather than an
 * estimate from the file's size — which would be wrong by the compression
 * ratio, and wrong in the direction that refuses a text file that gzip turns
 * into one second of video.
 *
 * Exported for the test, and worded for whoever reads it in the UI: the two
 * ways out are raising the cap on the channel and making the file smaller, so
 * both are named.
 */
export function tooLongForYoutube(
  frames: number | null,
  verified = false,
  fps = FPS,
): string | null {
  if (!frames) return null;
  const cap = verified ? VERIFIED_MAX_VIDEO_SECONDS : UNVERIFIED_MAX_VIDEO_SECONDS;
  const seconds = Math.ceil(frames / fps);
  if (seconds <= cap) return null;

  return (
    `too long for this channel: the encode is ${clock(seconds)} of video and the limit is ` +
    `${clock(cap)}. ` +
    (verified
      ? 'Split the file and upload the parts'
      : "Verify the channel's phone number to raise it to 12 hours, or turn the switch on in " +
        'Accounts if it is already verified')
  );
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
