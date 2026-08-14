import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { randomBytes } from 'node:crypto';

/**
 * Cross-process mutex around a single account's cookie jar.
 *
 * yt-dlp rotates Google session cookies on every run and writes the new values
 * back. If two runs share a jar concurrently — the worker verifying an upload
 * while the API serves a restore, which are separate processes — each rotates
 * from the same starting point and the second write clobbers the first. Google
 * then invalidates the session entirely, and every stored file becomes
 * unreachable until a human exports fresh cookies.
 *
 * Redis rather than an in-process lock precisely because the two halves of the
 * app never share memory.
 */
@Injectable()
export class CookieLock implements OnModuleDestroy {
  private readonly log = new Logger(CookieLock.name);
  private readonly redis: IORedis;

  /** Long enough for a slow 4K download, short enough that a crash self-heals. */
  private readonly ttlMs = 15 * 60 * 1000;

  constructor(config: ConfigService) {
    this.redis = new IORedis({
      host: config.get<string>('REDIS_HOST', '127.0.0.1'),
      port: Number(config.get<string>('REDIS_PORT', '6379')),
      maxRetriesPerRequest: null,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  async acquire<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const key = `cookies:lock:${accountId}`;
    const token = randomBytes(16).toString('hex');
    const deadline = Date.now() + this.ttlMs;

    while (Date.now() < deadline) {
      const won = await this.redis.set(key, token, 'PX', this.ttlMs, 'NX');
      if (won) {
        try {
          return await fn();
        } finally {
          // Release only if still ours; a lock that expired mid-run now
          // belongs to somebody else and must not be deleted.
          await this.redis.eval(
            `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
            1,
            key,
            token,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 250));
    }

    throw new Error(`timed out waiting for the cookie jar of account ${accountId}`);
  }
}
