import { Module } from '@nestjs/common';
import { YoutubeService } from './youtube.service';
import { YtdlpService } from './ytdlp.service';

@Module({
  providers: [YoutubeService, YtdlpService],
  exports: [YoutubeService, YtdlpService],
})
export class YoutubeModule {}
