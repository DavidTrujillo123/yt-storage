import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Keeps the bytes of files that have already been restored from YouTube.
 *
 * Pulling a file back is expensive in a way nothing else here is: a yt-dlp
 * download of the whole video, a full decode, and the cookie lock held for the
 * duration. Doing that twice for the same bytes — a preview, then a download
 * — is pure waste.
 *
 * Entries are named by sha256, so a hit is bytes whose identity is already
 * known; there is nothing to re-verify. And the cache is *disposable*: it is
 * never the copy of record, it is evicted under a byte budget, and deleting the
 * whole directory costs nothing but time. That distinction matters, because the
 * rule that makes this system trustworthy — local copies survive until YouTube
 * has been read back successfully — must never come to rest on a cache.
 */
@Injectable()
export class RestoreCache {
  private readonly log = new Logger(RestoreCache.name);
  private readonly dir: string;
  private readonly budget: number;

  constructor(config: ConfigService) {
    this.dir = join(config.get<string>('DATA_DIR', './data'), 'cache');
    this.budget = Number(config.get<string>('CACHE_MAX_BYTES', String(2 * 1024 ** 3)));
  }

  /** The cached path if it is there, touched so eviction sees it as recent. */
  async get(sha256: string): Promise<string | null> {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) return null;
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
    return path;
  }

  /**
   * Moves a freshly restored file into the cache and returns its new path.
   *
   * A move rather than a copy: the source is scratch that its caller is about
   * to delete, and both live under DATA_DIR so the rename stays on one
   * filesystem. Failure is not an error — a cache that cannot be written is a
   * slow app, not a broken one.
   */
  async put(sha256: string, from: string): Promise<string | null> {
    try {
      await mkdir(this.dir, { recursive: true });
      const path = this.pathFor(sha256);
      await rename(from, path);
      await this.evict();
      return path;
    } catch (error) {
      this.log.warn(`could not cache ${sha256.slice(0, 12)}: ${(error as Error).message}`);
      return null;
    }
  }

  async forget(sha256: string): Promise<void> {
    await rm(this.pathFor(sha256), { force: true }).catch(() => undefined);
  }

  /** Oldest first, until the directory is back inside its budget. */
  private async evict(): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = join(this.dir, name);
        const info = await stat(path).catch(() => null);
        return info?.isFile() ? { path, size: info.size, used: info.mtimeMs } : null;
      }),
    );

    const present = entries.filter((entry) => entry !== null);
    let total = present.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= this.budget) return;

    for (const entry of present.sort((a, b) => a.used - b.used)) {
      if (total <= this.budget) break;
      await rm(entry.path, { force: true }).catch(() => undefined);
      total -= entry.size;
      this.log.log(`evicted ${entry.path.split('/').pop()} to stay under the cache budget`);
    }
  }

  /** The name is the hash, which is what makes a hit self-verifying. */
  private pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
    return join(this.dir, sha256);
  }
}
