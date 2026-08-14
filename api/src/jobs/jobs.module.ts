import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CodecModule } from '../codec/codec.module';
import { FilesModule } from '../files/files.module';
import { YoutubeModule } from '../youtube/youtube.module';
import { ENCODE_QUEUE, UPLOAD_QUEUE, VERIFY_QUEUE } from './queues';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoredFile } from '../files/stored-file.entity';
import { ReconcileService } from './reconcile.service';
import { EncodeProcessor } from './encode.processor';
import { UploadProcessor } from './upload.processor';
import { VerifyProcessor } from './verify.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([StoredFile]),
    CodecModule,
    FilesModule,
    YoutubeModule,
    BullModule.registerQueue(
      { name: ENCODE_QUEUE },
      { name: UPLOAD_QUEUE },
      { name: VERIFY_QUEUE },
    ),
  ],
  providers: [ReconcileService, EncodeProcessor, UploadProcessor, VerifyProcessor],
})
export class JobsModule {}
