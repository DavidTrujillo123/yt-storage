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

  /**
   * The lease, and how long a crashed holder keeps the jar to itself.
   *
   * Short on purpose, because it is renewed: the previous value was fifteen
   * minutes because that was the longest plausible download, which put the
   * expiry a rounding error away from a measured 14m46s restore. A lease that
   * expires mid-download is the exact disaster this lock exists to prevent —
   * a second process takes the jar, both rotate the Google session from the
   * same starting point, and the account is signed out until a human exports
   * cookies again.
   */
  private readonly ttlMs = 5 * 60 * 1000;

  /** How often the lease is extended while the work is still running. */
  private readonly renewMs = 60 * 1000;

  /**
   * How long a caller waits for the jar before giving up.
   *
   * Separate from the lease, which it used to share. Sharing them meant the
   * only way to wait longer was to hold longer, so a queued preview died with
   * a 500 at exactly the moment the download ahead of it was most at risk.
   */
  private readonly waitMs = 30 * 60 * 1000;

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
    const deadline = Date.now() + this.waitMs;

    while (Date.now() < deadline) {
      const won = await this.redis.set(key, token, 'PX', this.ttlMs, 'NX');
      if (won) {
        // Extended while the work runs, so the lease covers a download of any
        // length without ever leaving a crashed holder's lock standing for
        // longer than one ttl. `XX` is what keeps this honest: a lease that
        // has already lapsed belongs to somebody else and is not renewed.
        const renewal = setInterval(() => {
          this.redis
            .set(key, token, 'PX', this.ttlMs, 'XX')
            .then((held) => {
              if (!held) this.log.warn(`lost the cookie lease of account ${accountId} mid-run`);
            })
            .catch((error: Error) => this.log.warn(`could not renew the cookie lease: ${error.message}`));
        }, this.renewMs);
        // Nothing should be kept alive by a heartbeat.
        renewal.unref?.();

        try {
          return await fn();
        } finally {
          clearInterval(renewal);
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
