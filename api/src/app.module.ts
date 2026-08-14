import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import IORedis from 'ioredis';
import { DatabaseModule } from './database.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { AdminSeed } from './auth/admin-seed';
import { AccountsModule } from './accounts/accounts.module';
import { CookiesHealthCheck } from './accounts/cookies.health';
import { YtAccount } from './accounts/yt-account.entity';
import { YoutubeModule } from './youtube/youtube.module';
import { CodecModule } from './codec/codec.module';
import { FilesModule } from './files/files.module';
import { JobsModule } from './jobs/jobs.module';
import { StatusController } from './status.controller';

/**
 * Two entry points share this module, and the split matters: the HTTP process
 * must never register the processors. Encoding pins a CPU core for minutes at a
 * time, so any request landing on that process would simply hang.
 */
@Module({})
export class AppModule {
  static register(withWorkers: boolean): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            // An explicit client instead of connection options: BullMQ loads
            // ioredis with a bare dynamic require, which pnpm's strict layout
            // hides from it.
            connection: new IORedis({
              host: config.get<string>('REDIS_HOST', '127.0.0.1'),
              port: Number(config.get<string>('REDIS_PORT', '6379')),
              maxRetriesPerRequest: null,
            }),
            defaultJobOptions: { removeOnComplete: 50, removeOnFail: 200 },
          }),
        }),
        ScheduleModule.forRoot(),
        TypeOrmModule.forFeature([YtAccount]),
        DatabaseModule,
        CommonModule,
        AuthModule,
        AccountsModule,
        YoutubeModule,
        CodecModule,
        FilesModule,
        ...(withWorkers ? [JobsModule] : []),
      ],
      controllers: [StatusController],
      // The seeder belongs to the HTTP process alone. Both processes start at
      // once against one database, and two of them inserting the same email is
      // a race with nothing to win.
      providers: [CookiesHealthCheck, ...(withWorkers ? [] : [AdminSeed])],
    };
  }
}
