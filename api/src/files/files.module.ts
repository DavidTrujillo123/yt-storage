import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoredFile } from './stored-file.entity';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { RestoreCache } from './restore-cache';
import { RestoreProgress } from './restore-progress';
import { CodecModule } from '../codec/codec.module';
import { YoutubeModule } from '../youtube/youtube.module';
import { ENCODE_QUEUE, UPLOAD_QUEUE, VERIFY_QUEUE } from '../jobs/queues';

@Module({
  imports: [
    TypeOrmModule.forFeature([StoredFile]),
    CodecModule,
    YoutubeModule,
    // All three, because a retry can re-arm any stage from the HTTP process.
    BullModule.registerQueue({ name: ENCODE_QUEUE }, { name: UPLOAD_QUEUE }, { name: VERIFY_QUEUE }),
    // Uploads stream straight to disk. Buffering a multi-gigabyte file in
    // memory to then write it out anyway would cap the app's file size at
    // whatever the heap allows.
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const dest = join(config.get<string>('DATA_DIR', './data'), 'incoming');
        mkdirSync(dest, { recursive: true });
        return {
          // Without this busboy drops the directory part of every filename,
          // and a folder upload arrives as a flat pile of basenames — the
          // structure the browser reported in webkitRelativePath is gone
          // before any code here sees it. What lands on disk is still a
          // randomUUID, so the preserved path is only ever data.
          preservePath: true,
          storage: diskStorage({
            destination: dest,
            filename: (_req, _file, cb) => cb(null, randomUUID()),
          }),
          // Encoding needs roughly 5x the file size in scratch space, so an
          // unbounded upload is a straightforward way to fill the disk.
          limits: { fileSize: Number(config.get<string>('MAX_UPLOAD_BYTES', String(5 * 1024 ** 3))) },
        };
      },
    }),
  ],
  controllers: [FilesController],
  providers: [FilesService, RestoreCache, RestoreProgress],
  exports: [FilesService, RestoreCache, RestoreProgress],
})
export class FilesModule {}
