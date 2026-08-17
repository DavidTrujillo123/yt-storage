import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { join } from 'node:path';
import { CodecService } from '../codec/codec.service';
import { FilesService } from '../files/files.service';
import { ENCODE_QUEUE, FileJob, UPLOAD_QUEUE } from './queues';

@Processor(ENCODE_QUEUE, { concurrency: 1 })
export class EncodeProcessor extends WorkerHost {
  private readonly log = new Logger(EncodeProcessor.name);

  constructor(
    private readonly files: FilesService,
    private readonly codec: CodecService,
    @InjectQueue(UPLOAD_QUEUE) private readonly uploadQueue: Queue<FileJob>,
  ) {
    super();
  }

  async process(job: Job<FileJob>): Promise<void> {
    const file = await this.files.getById(job.data.fileId);
    if (!file.sourcePath) throw new Error('source file is already gone');

    try {
      await this.files.setStatus(file.id, 'ENCODING');
      const dir = await this.files.ensureDir('videos');
      const videoPath = join(dir, `${file.id}.mp4`);

      // One row written per percentage point, not per group. The codec reports
      // a group at a time — four hundred of them for a six-hundred-megabyte
      // file — and a percentage only has a hundred values to move through.
      let reported = -1;
      const result = await this.codec.encode(file.sourcePath, videoPath, (percent) => {
        if (percent === reported) return;
        reported = percent;
        void this.files.update(file.id, { progress: percent });
      });

      await this.files.update(file.id, {
        videoPath,
        frames: result.frames,
        videoBytes: result.videoBytes,
        // Recorded here because here is the only place that knows without
        // reading the video back: every restore of this file now skips the
        // detection pass, and a partial read has a grid to measure groups in
        // before it has decoded a single frame.
        layout: result.layout,
        progress: 100,
      });

      this.log.log(
        // size is only ever null on a row imported from the channel, which has
        // no local bytes and therefore never reaches an encode.
        `${file.name}: ${result.layout} layout, ${result.frames} frames, ` +
          `${(result.videoBytes / (file.size ?? 0)).toFixed(1)}x bloat`,
      );
      await this.uploadQueue.add('upload', { fileId: file.id }, { jobId: file.id });
    } catch (error) {
      await this.files.fail(file.id, error);
      throw error;
    }
  }
}
