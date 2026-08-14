import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Session, User } from './auth/user.entity';
import { YtAccount } from './accounts/yt-account.entity';
import { StoredFile } from './files/stored-file.entity';
import { Setting } from './common/setting.entity';

export const ENTITIES = [User, Session, YtAccount, StoredFile, Setting];

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const database = config.get<string>('DATABASE_PATH', './data/yt-storage.db');
        mkdirSync(dirname(database), { recursive: true });
        return {
          type: 'better-sqlite3' as const,
          database,
          entities: ENTITIES,
          // Fine for a single-file SQLite database that one person owns; swap
          // for migrations before this ever holds someone else's data.
          synchronize: config.get<string>('DB_SYNC', 'true') === 'true',
          // The API and the worker are separate processes on one database file.
          // Without WAL they block each other on every write and the worker
          // dies with "database is locked" mid-encode; busy_timeout covers the
          // brief overlaps WAL still allows.
          prepareDatabase: (db: {
            pragma: (statement: string) => unknown;
          }) => {
            db.pragma('journal_mode = WAL');
            db.pragma('busy_timeout = 10000');
            db.pragma('synchronous = NORMAL');
          },
        };
      },
    }),
  ],
})
export class DatabaseModule {}
