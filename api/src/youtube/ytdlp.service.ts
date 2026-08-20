import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MIN_DECODABLE_HEIGHT } from './constants';
import { AccountsService } from '../accounts/accounts.service';

interface Format {
  height?: number | null;
  vcodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  /** Video bitrate in kbit/s, as yt-dlp reports it. */
  vbr?: number | null;
  tbr?: number | null;
}

/**
 * One rendition YouTube is serving, with what it costs to fetch.
 *
 * The bytes are the point. A restore's wall clock is almost entirely the
 * download, so "which height decodes" is only half the question — the other
 * half is how much each one weighs, and until now that number was parsed out of
 * yt-dlp's answer and thrown away.
 */
export interface Rendition {
  height: number;
  codec: string;
  /** Null when yt-dlp offers neither an exact size nor an estimate. */
  bytes: number | null;
  /** Kbit/s, which is what a per-resolution cap would show up in. */
  bitrate: number | null;
}

export interface DownloadOptions {
  /**
   * Served height to ask for: the decoder's floor by default, and `null` for
   * the best rendition at or above it — which is what every download did
   * before there was a choice.
   */
  height?: number | null;
  /** Fetch only these seconds of the video rather than all of it. */
  section?: { fromSeconds: number; toSeconds: number };
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
 * The jar is no longer a session. Its own class because callers answer it
 * differently from every other yt-dlp failure: nothing about the file or the
 * request is wrong, so it is a 4xx pointing at the Accounts page rather than a
 * 500, and a retry cannot help until somebody captures cookies again.
 */
export class CookiesExpiredError extends YtdlpError {
  constructor(message: string, stderr: string, argv: string[]) {
    super(message, stderr, argv);
    this.name = 'CookiesExpiredError';
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

  private run(
    args: string[],
    collect = true,
    onLine?: (line: string) => void,
  ): Promise<{ stdout: string; stderr: string }> {
    // The argv is logged in full on every call. Without it a failure is
    // indistinguishable from a different failure, and this code path has
    // already cost days of guessing at which flags were actually in play.
    this.log.log(`yt-dlp ${this.redact(args).join(' ')}`);

    return new Promise((resolve, reject) => {
      const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      if (collect) proc.stdout.on('data', (c) => (stdout += c));
      else if (onLine) {
        // Progress lines only, split on the newlines --newline guarantees; a
        // chunk can end mid-line, so the remainder waits for the next one.
        let buffer = '';
        proc.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) onLine(line.trim());
        });
      } else proc.stdout.resume();
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
   *
   * `height` asks for that rung exactly, and only then for the best rung at or
   * above the floor. That order is the whole point: these uploads are 4K, so
   * `bestvideo` alone means the 2160p rendition, roughly four times the bytes
   * of the 1080p one — and every grid here is measured readable at 1080p. The
   * fallbacks can only ever land *higher* than what was asked for, so the
   * worst case is today's behaviour rather than an unreadable file.
   */
  private formatFor(height: number | null): string {
    const best = `bestvideo[height>=${MIN_DECODABLE_HEIGHT}]/best[height>=${MIN_DECODABLE_HEIGHT}]`;
    return height === null ? best : `bestvideo[height=${height}]/${best}`;
  }

  /**
   * The player clients yt-dlp asks, and the reason this app can read anything
   * back at all.
   *
   * yt-dlp's own defaults answer these uploads with the HLS ladder and nothing
   * else: one muxed rendition per rung, capped at 1080p. That ladder is a
   * re-encode of a re-encode, and measured against a real file it is enough
   * for `wide` — four pixels a block — and not enough for `dense`, whose two
   * pixels come back smeared. Every `dense` upload was therefore unreadable:
   * verification retried for a day and restores failed on the first group.
   *
   * `web_embedded` is the client that still answers with the adaptive DASH
   * formats — 1080p, 1440p and 2160p as separate video-only streams, at four
   * to eight times the ladder's bitrate. It is added rather than substituted:
   * the defaults stay first, so nothing that works today changes, and the DASH
   * rungs are merged in behind them for the format selector to find.
   */
  private get clientArgs(): string[] {
    return ['--extractor-args', 'youtube:player_client=default,web_embedded'];
  }

  /**
   * How many DASH fragments yt-dlp fetches at once.
   *
   * YouTube serves these as fragments and yt-dlp takes them one at a time by
   * default — a single stream on a link with room for several. A restore moves
   * gigabytes, and the download measured as three quarters of its wall clock,
   * so this is the number that matters most in this file.
   */
  private get fragments(): string {
    return String(Math.max(MIN_FRAGMENTS, Math.min(this.ceiling, this.configuredFragments)));
  }

  /** What the operator asked for, before anything YouTube has said about it. */
  private get configuredFragments(): number {
    const asked = Number(process.env.YTDLP_CONCURRENT_FRAGMENTS);
    return Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : DEFAULT_FRAGMENTS;
  }

  /**
   * The current cap, which only YouTube moves.
   *
   * Raising concurrency is the one lever that acts directly on a restore's wall
   * clock — a download measured as essentially all of it — but the same lever
   * is what earns a bot check, and a bot check is a *failed* retrieval. So the
   * asked-for number is a ceiling to aim at rather than a promise: every
   * rate-limited failure halves it, and it climbs back one step per success so
   * a single bad afternoon does not pin the instance at four forever.
   */
  private ceiling = Number.POSITIVE_INFINITY;

  /** Called when YouTube answers a download with "slow down". */
  private backOff(): void {
    const from = Math.min(this.ceiling, this.configuredFragments);
    this.ceiling = Math.max(MIN_FRAGMENTS, Math.floor(from / 2));
    this.log.warn(
      `YouTube pushed back on the request rate; concurrent fragments capped at ${this.ceiling} ` +
        `(asked for ${this.configuredFragments})`,
    );
  }

  /** Called when one completes without complaint. */
  private easeUp(): void {
    if (this.ceiling >= this.configuredFragments) return;
    this.ceiling = Math.min(this.configuredFragments, this.ceiling + FRAGMENT_STEP);
    this.log.log(`raising concurrent fragments back to ${this.ceiling}`);
  }

  /**
   * Heights YouTube currently serves, highest first. Diagnostics only.
   *
   * `-f bestvideo*` is required, not cosmetic: the encoder emits video whose
   * audio track is a token silent stream, and yt-dlp runs its default selector
   * even when only dumping JSON. Without an explicit selector it aborts with
   * "Requested format is not available" and never reports anything.
   */
  async availableHeights(accountId: string, videoId: string): Promise<number[]> {
    return (await this.renditions(accountId, videoId)).map((rendition) => rendition.height);
  }

  /**
   * Every video rendition YouTube is serving, largest first, with its weight.
   *
   * The same yt-dlp call `availableHeights` always made — it asks for the whole
   * info JSON and used to keep one field out of it. What a restore actually
   * costs is bytes, so the sizes and bitrates come out too: they are what turns
   * "1080p does not decode" from a fact into an explanation, by showing whether
   * the smaller rendition is starved of bitrate or merely smaller.
   *
   * The biggest format at each height wins. YouTube serves several codecs per
   * rung and the app's format selector takes the best, so reporting the worst
   * would describe a download nobody makes.
   */
  /**
   * How many seconds of video YouTube is holding, or null when it will not say.
   *
   * The cheapest question there is — metadata only, no formats fetched and no
   * bytes downloaded — and the one that catches an upload that never finished.
   * A video that is shorter than the container header says it should be is
   * missing whole groups, and no amount of parity rebuilds a group that was
   * never stored: the redundancy is 6 frames in every 30 *within* a group.
   */
  async duration(accountId: string, videoId: string): Promise<number | null> {
    const { stdout } = await this.accounts.withCookies(accountId, (cookiePath) =>
      this.run([
        '--cookies', cookiePath,
        ...this.clientArgs,
        '--skip-download', '--no-warnings',
        '--print', '%(duration)s',
        this.url(videoId),
      ]),
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  async renditions(accountId: string, videoId: string): Promise<Rendition[]> {
    const { stdout } = await this.accounts.withCookies(accountId, (cookiePath) =>
      this.run(['--cookies', cookiePath, ...this.clientArgs, '-J', '-f', 'bestvideo*', this.url(videoId)]),
    );
    const info = JSON.parse(stdout) as { formats?: Format[] };

    const best = new Map<number, Rendition>();
    for (const format of info.formats ?? []) {
      if (!format.vcodec || format.vcodec === 'none' || typeof format.height !== 'number') continue;
      const bytes = format.filesize ?? format.filesize_approx ?? null;
      const candidate: Rendition = {
        height: format.height,
        codec: format.vcodec,
        bytes,
        bitrate: format.vbr ?? format.tbr ?? null,
      };
      const held = best.get(format.height);
      if (!held || (bytes ?? 0) > (held.bytes ?? 0)) best.set(format.height, candidate);
    }

    return [...best.values()].sort((a, b) => b.height - a.height);
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

  /**
   * `onProgress` receives 0-100, or null while the size is still unknown. It is
   * the only honest thing to show during a restore: a 400 MB video takes
   * minutes, and the alternative is a spinner that looks the same whether the
   * download is running or wedged.
   */
  async download(
    accountId: string,
    videoId: string,
    outPath: string,
    onProgress?: (percent: number | null) => void,
    options: DownloadOptions = {},
  ): Promise<void> {
    const height = options.height === undefined ? MIN_DECODABLE_HEIGHT : options.height;
    const section = options.section;
    await this.accounts.withCookies(accountId, async (cookiePath) => {
      try {
        // No --no-warnings. yt-dlp reports the things that matter here as
        // warnings, not errors: a player client falling back, nsig extraction
        // failing, "Sign in to confirm you're not a bot". Suppressing them is
        // what made this failure look like it had no cause.
        await this.run(
          [
            '--cookies', cookiePath,
            ...this.clientArgs,
            '-f', this.formatFor(height),
            // Only the seconds of video a caller asked for. yt-dlp keeps the
            // fragments that overlap the range and remuxes them, so the
            // picture is untouched — no re-encode, and therefore nothing the
            // decoder has to survive that a whole download would not.
            //
            // The range is generous on both sides by the time it gets here:
            // the cut lands on fragment boundaries, not on the second asked
            // for, and every frame states its own group so a wide cut costs
            // frames rather than correctness.
            ...(section
              ? ['--download-sections', `*${section.fromSeconds}-${section.toSeconds}`]
              : []),
            '--no-part',
            // Without this, a file left behind by an interrupted attempt is
            // treated as a partial download to resume, and YouTube answers
            // "HTTP Error 416: Requested range not satisfiable" — for good,
            // until somebody deletes the file by hand.
            '--force-overwrites',
            '--concurrent-fragments', this.fragments,
            // One progress line per update instead of a carriage-returned bar,
            // and only the two numbers this needs. `total_bytes` is absent
            // until the download starts and stays NA for some fragmented
            // streams, so the estimate is the fallback.
            '--newline',
            '--progress-template',
            `${PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s`,
            '-o', outPath,
            this.url(videoId),
          ],
          false,
          onProgress &&
            ((line) => {
              const percent = percentIn(line);
              if (percent !== undefined) onProgress(percent);
            }),
        );
        // One clean download is the only evidence that the current rate is
        // being tolerated, so it is the only thing allowed to raise the cap.
        this.easeUp();
      } catch (error) {
        const message = (error as Error).message;
        // Before the session check, not after it, and deliberately not
        // exclusive with it. "Sign in to confirm you're not a bot" is both
        // wordings at once — it is what a signed-out client is asked and what
        // a client asking too fast is asked — and there is no way to tell them
        // apart from here. Slowing down costs a slower restore; not slowing
        // down costs failed ones.
        if (looksRateLimited(message)) this.backOff();
        if (looksSignedOut(message)) {
          // The jar no longer authenticates, and the video being private is
          // only how that shows up: YouTube answers a signed-out request for
          // any private video with exactly this sentence, so yt-dlp's wording
          // sends everyone looking at the video instead of at the session.
          // Recording it is what makes the Accounts page say so too, rather
          // than leaving a jar marked OK that has not worked for hours.
          await this.accounts.recordCookieHealth(accountId, false);
          throw new CookiesExpiredError(
            `the stored cookies for this account no longer authenticate, so ${videoId} reads as ` +
              'a private video nobody is signed in to see. Capture the session again from the ' +
              'Accounts page (yt-dlp: ' +
              `${firstLine(error)})`,
            error instanceof YtdlpError ? error.stderr : message,
            error instanceof YtdlpError ? error.argv : [],
          );
        }
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
    const at = section ? ` ${section.fromSeconds}-${section.toSeconds}s` : '';
    this.log.log(`downloaded ${videoId}${at} at ${height === null ? 'the best height' : `${height}p`}`);
  }

  /** Cheap authenticated round-trip used by the cookie health check. */
  async checkAuth(accountId: string, videoId: string): Promise<boolean> {
    try {
      await this.accounts.withCookies(accountId, (cookiePath) =>
        this.run([
          '--cookies', cookiePath,
          ...this.clientArgs,
          '--simulate', '--no-warnings',
          this.url(videoId),
        ]),
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

/** Marks the lines written by --progress-template, so the rest can be ignored. */
const PROGRESS_PREFIX = 'yts-progress';

/** Fragments fetched at once when nothing says otherwise. */
const DEFAULT_FRAGMENTS = 16;

/**
 * The floor the back-off will not go under.
 *
 * One fragment at a time is yt-dlp's own default and it is what made a restore
 * take a quarter of an hour in the first place. Four is slow, not broken —
 * somewhere to sit out a rate limit rather than somewhere to end up.
 */
const MIN_FRAGMENTS = 4;

/** How fast the cap climbs back after a clean download. */
const FRAGMENT_STEP = 4;

/**
 * The percentage on a progress line: a number, null while the total is still
 * unknown, and undefined for any other line yt-dlp prints.
 *
 * The three cases are distinct on purpose. Treating "not a progress line" as
 * null would blank a bar that was already moving, every time yt-dlp mentions a
 * player client.
 */
export function percentIn(line: string): number | null | undefined {
  if (!line.startsWith(PROGRESS_PREFIX)) return undefined;

  const [done, total] = line.slice(PROGRESS_PREFIX.length).trim().split(/\s+/);
  const bytes = Number(done);
  const size = Number(total);
  if (!Number.isFinite(bytes) || !Number.isFinite(size) || size <= 0) return null;
  return (bytes / size) * 100;
}

/**
 * Whether yt-dlp's complaint is really "this request was not signed in".
 *
 * Every upload here is private, so an unauthenticated request cannot tell a
 * missing video from one it is simply not allowed to see — and YouTube says
 * "Private video" for both. The bot check is the same class of answer: it is
 * what a signed-out client gets asked.
 */
function looksSignedOut(message: string): boolean {
  return (
    message.includes('Private video') ||
    message.includes('Sign in to confirm') ||
    message.includes('This video is available to this channel')
  );
}

/**
 * Whether YouTube is pushing back on the *rate* rather than on the session.
 *
 * The two overlap — "Sign in to confirm you're not a bot" is what a client
 * asking too fast gets, and also what a signed-out one gets — which is why the
 * caller checks the session first and only reaches this once the cookies are
 * known good. Everything here is YouTube saying "slow down" in one of the
 * several wordings it uses for it.
 */
export function looksRateLimited(message: string): boolean {
  return (
    message.includes('HTTP Error 429') ||
    message.includes('Too Many Requests') ||
    message.includes("Sign in to confirm you're not a bot") ||
    message.includes('The download speed is below') ||
    message.includes('Got error: HTTPSConnectionPool')
  );
}

/** For log lines and error messages; run() has already logged the whole thing. */
export function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}
