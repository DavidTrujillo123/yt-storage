import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MIN_DECODABLE_HEIGHT } from './constants';
import { AccountsService } from '../accounts/accounts.service';

interface Format {
  height?: number | null;
  vcodec?: string;
}

/**
 * A yt-dlp failure with its output intact.
 *
 * The stderr was being flattened to its first line at every call site, which
 * hid the actual reason more than once — a warning two lines down is regularly
 * the whole story ("Sign in to confirm you're not a bot", a player client
 * falling back, nsig extraction failing). Keep it on the error and let the
 * consumer decide how much to print.
 */
export class YtdlpError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly argv: string[],
  ) {
    super(message);
    this.name = 'YtdlpError';
  }
}

/**
 * yt-dlp wrapper.
 *
 * Every call pins a minimum height. The codec's decoder needs roughly 3.3
 * pixels per 4-px block, which measured out as a hard floor near 900p — a
 * 720p download decodes to nothing at all. Letting yt-dlp fall back to a
 * smaller format would silently produce an unrecoverable file, so the format
 * selector has no fallback on purpose: better a loud failure than a lost file.
 */
@Injectable()
export class YtdlpService {
  private readonly log = new Logger(YtdlpService.name);

  constructor(private readonly accounts: AccountsService) {}

  private run(args: string[], collect = true): Promise<{ stdout: string; stderr: string }> {
    // The argv is logged in full on every call. Without it a failure is
    // indistinguishable from a different failure, and this code path has
    // already cost days of guessing at which flags were actually in play.
    this.log.log(`yt-dlp ${this.redact(args).join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      if (collect) proc.stdout.on('data', (c) => (stdout += c));
      else proc.stdout.resume();
      proc.stderr.on('data', (c) => (stderr += c));

      proc.on('error', (error) =>
        reject(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? new Error('yt-dlp is not installed (brew install yt-dlp)')
            : error,
        ),
      );
      proc.on('close', (code) => {
        if (code === 0) return resolve({ stdout, stderr });
        this.log.warn(`yt-dlp exited ${code}\nargv: ${this.redact(args).join(' ')}\n${stderr.trim()}`);
        reject(new YtdlpError(stderr.trim() || `yt-dlp exited ${code}`, stderr.trim(), this.redact(args)));
      });
    });
  }

  /** The cookie path is a tempdir, not a secret, but it is noise in every log line. */
  private redact(args: string[]): string[] {
    return args.map((arg, index) => (args[index - 1] === '--cookies' ? '<cookies>' : arg));
  }

  /**
   * The format selector, defined once.
   *
   * `bestvideo` matches only video-only renditions; `best` covers a video whose
   * sole option at this height is muxed. Neither falls back below the floor —
   * a silent drop to 720p would yield a file the decoder cannot read, which is
   * worse than a loud failure.
   */
  private readonly format =
    `bestvideo[height>=${MIN_DECODABLE_HEIGHT}]/best[height>=${MIN_DECODABLE_HEIGHT}]`;

  /**
   * Heights YouTube currently serves, highest first. Diagnostics only.
   *
   * `-f bestvideo*` is required, not cosmetic: the encoder emits video whose
   * audio track is a token silent stream, and yt-dlp runs its default selector
   * even when only dumping JSON. Without an explicit selector it aborts with
   * "Requested format is not available" and never reports anything.
   */
  async availableHeights(accountId: string, videoId: string): Promise<number[]> {
    const { stdout } = await this.accounts.withCookies(accountId, (cookiePath) =>
      this.run(['--cookies', cookiePath, '-J', '-f', 'bestvideo*', this.url(videoId)]),
    );
    const info = JSON.parse(stdout) as { formats?: Format[] };
    const heights = (info.formats ?? [])
      .filter((f) => f.vcodec && f.vcodec !== 'none' && typeof f.height === 'number')
      .map((f) => f.height as number);
    return [...new Set(heights)].sort((a, b) => b - a);
  }

  /**
   * What YouTube will actually serve, as a line fit to store on the file row.
   *
   * The point is to answer "did this video ever get a 1080p rendition?" from
   * inside the app, because the alternative — exporting the cookie jar and
   * running yt-dlp by hand — has killed two sessions already.
   */
  async describeFormats(accountId: string, videoId: string): Promise<string> {
    try {
      const heights = await this.availableHeights(accountId, videoId);
      return heights.length ? `available heights: ${heights.join(', ')}` : 'no video formats offered';
    } catch (error) {
      return `could not list formats: ${firstLine(error)}`;
    }
  }

  async download(accountId: string, videoId: string, outPath: string): Promise<void> {
    await this.accounts.withCookies(accountId, async (cookiePath) => {
      try {
        // No --no-warnings. yt-dlp reports the things that matter here as
        // warnings, not errors: a player client falling back, nsig extraction
        // failing, "Sign in to confirm you're not a bot". Suppressing them is
        // what made this failure look like it had no cause.
        await this.run(
          [
            '--cookies', cookiePath,
            '-f', this.format,
            '--no-part',
            // Without this, a file left behind by an interrupted attempt is
            // treated as a partial download to resume, and YouTube answers
            // "HTTP Error 416: Requested range not satisfiable" — for good,
            // until somebody deletes the file by hand.
            '--force-overwrites',
            '-o', outPath,
            this.url(videoId),
          ],
          false,
        );
      } catch (error) {
        const message = (error as Error).message;
        if (message.includes('Requested format is not available')) {
          // Wrapped, not replaced. The old version threw away yt-dlp's own
          // output and left "still transcoding" as the only evidence, which is
          // a conclusion rather than an observation.
          throw new YtdlpError(
            `no format at ${MIN_DECODABLE_HEIGHT}p or better yet for ${videoId}; ` +
              `YouTube is still transcoding (yt-dlp: ${firstLine(error)})`,
            error instanceof YtdlpError ? error.stderr : message,
            error instanceof YtdlpError ? error.argv : [],
          );
        }
        throw error;
      }
    });
    this.log.log(`downloaded ${videoId}`);
  }

  /** Cheap authenticated round-trip used by the cookie health check. */
  async checkAuth(accountId: string, videoId: string): Promise<boolean> {
    try {
      await this.accounts.withCookies(accountId, (cookiePath) =>
        this.run(['--cookies', cookiePath, '--simulate', '--no-warnings', this.url(videoId)]),
      );
      return true;
    } catch (error) {
      this.log.warn(`cookie check failed: ${firstLine(error)}`);
      return false;
    }
  }

  private url(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
}

/** For log lines and error messages; run() has already logged the whole thing. */
export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}
