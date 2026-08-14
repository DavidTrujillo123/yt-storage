import { Module } from '@nestjs/common';
import { CodecService } from './codec.service';

@Module({
  providers: [CodecService],
  exports: [CodecService],
})
export class CodecModule {}
