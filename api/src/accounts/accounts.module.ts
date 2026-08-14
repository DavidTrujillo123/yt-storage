import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { YtAccount } from './yt-account.entity';
import { AccountsService } from './accounts.service';
import { CookieLock } from './cookie-lock';
import { AccountsController } from './accounts.controller';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([YtAccount]),
    // Memory storage, not disk: a plaintext cookie jar is a full Google account
    // credential and must never touch the filesystem unencrypted.
    MulterModule.register({ storage: memoryStorage(), limits: { fileSize: 1024 * 1024 } }),
  ],
  controllers: [AccountsController],
  providers: [AccountsService, CookieLock],
  exports: [AccountsService],
})
export class AccountsModule {}
