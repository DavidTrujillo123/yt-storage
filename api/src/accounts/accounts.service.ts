import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { SettingsService } from '../common/settings.service';
import { CookieHealth, YtAccount } from './yt-account.entity';
import {
  cookieHeaderFromPaste,
  filterCookieJar,
  hasSessionCookie,
  jarFromHeader,
} from './cookie-jar';
import { CookieLock } from './cookie-lock';
import {
  BrowserCapture,
  identifySession,
  listProfiles,
  type BrowserProfile,
  type CaptureProgress,
} from './browser-capture';
import { quotaIsStale, quotaSummary, selectUploadAccount } from './quota';
import { OAUTH_SCOPES } from '../youtube/constants';

/**
 * Where the browser lands after Google sends it back, as a closed set.
 *
 * `state` is data that leaves this app and comes back under someone else's
 * control, so it never reaches a redirect as text. It selects one of these
 * fixed paths or it selects nothing.
 */
const RETURN_PATHS = {
  accounts: '/accounts?connected=1',
  setup: '/setup?connected=1',
} as const;

export type ReturnTarget = keyof typeof RETURN_PATHS;

export function isReturnTarget(value: unknown): value is ReturnTarget {
  return typeof value === 'string' && value in RETURN_PATHS;
}

/** Splits the `<accountId>|<target>` state, tolerating the older id-only form. */
export function parseOAuthState(state: string): { accountId: string; returnTo: string } {
  const [accountId, target] = state.split('|');
  return { accountId, returnTo: isReturnTarget(target) ? RETURN_PATHS[target] : RETURN_PATHS.accounts };
}

/** Secret columns are `select: false`, so they must be asked for by name. */
const WITH_SECRETS = {
  id: true,
  userId: true,
  label: true,
  clientId: true,
  clientSecret: true,
  refreshToken: true,
  cookieJar: true,
  cookieHealth: true,
  uploadsToday: true,
  quotaResetAt: true,
} as const;

@Injectable()
export class AccountsService {
  private readonly log = new Logger(AccountsService.name);

  constructor(
    @InjectRepository(YtAccount) private readonly accounts: Repository<YtAccount>,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
    private readonly lock: CookieLock,
    private readonly capture: BrowserCapture,
  ) {}

  list(userId: string): Promise<YtAccount[]> {
    return this.accounts.find({ where: { userId }, order: { createdAt: 'ASC' } });
  }

  /**
   * Everything a caller needs to know about an account without exposing a
   * secret. `connected` in particular had no representation before: the API
   * could not tell you whether the OAuth round trip had ever completed.
   */
  async summarise(userId: string) {
    const accounts = await this.accounts.find({
      where: { userId },
      order: { createdAt: 'ASC' },
      select: { ...WITH_SECRETS, cookieCheckedAt: true, createdAt: true },
    });

    return accounts.map((account) => ({
      id: account.id,
      label: account.label,
      clientId: account.clientId,
      connected: account.refreshToken !== null,
      hasCookies: account.cookieJar !== null,
      cookieHealth: account.cookieHealth,
      cookieCheckedAt: account.cookieCheckedAt,
      quota: this.quotaSummary(account),
      ready: account.refreshToken !== null && account.cookieJar !== null,
      createdAt: account.createdAt,
    }));
  }

  async create(
    userId: string,
    input: { label: string; clientId: string; clientSecret: string },
  ): Promise<YtAccount> {
    const account = this.accounts.create({
      userId,
      label: input.label,
      clientId: input.clientId,
      clientSecret: this.settings.seal(input.clientSecret),
    });
    return this.accounts.save(account);
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.accounts.delete({ id, userId });
    if (!result.affected) throw new NotFoundException(`no account ${id}`);
  }

  /** Ownership is checked here, not in the controller, so no path can skip it. */
  async loadSecret(userId: string, id: string): Promise<YtAccount> {
    const account = await this.accounts.findOne({ where: { id, userId }, select: WITH_SECRETS });
    if (!account) throw new NotFoundException(`no account ${id}`);
    return account;
  }

  async loadSecretById(id: string): Promise<YtAccount> {
    const account = await this.accounts.findOne({ where: { id }, select: WITH_SECRETS });
    if (!account) throw new NotFoundException(`no account ${id}`);
    return account;
  }

  // --- OAuth ---------------------------------------------------------------

  oauthClient(account: YtAccount): InstanceType<typeof google.auth.OAuth2> {
    return new google.auth.OAuth2(
      account.clientId,
      this.settings.openText(account.clientSecret),
      this.config.get<string>('GOOGLE_REDIRECT_URI', 'http://localhost:3000/accounts/callback'),
    );
  }

  /**
   * `access_type: offline` with `prompt: consent` is what actually returns a
   * refresh token — Google omits it on repeat authorisations otherwise, and the
   * account then silently dies the first time its access token expires.
   *
   * The account id rides in `state` so the callback knows which of a user's
   * accounts it is completing, followed by where to send the browser afterwards
   * — the wizard and the accounts page both start this round trip.
   */
  authUrl(account: YtAccount, returnTo: ReturnTarget = 'accounts'): string {
    return this.oauthClient(account).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: OAUTH_SCOPES,
      state: `${account.id}|${returnTo}`,
    });
  }

  async completeOAuth(accountId: string, code: string): Promise<void> {
    const account = await this.loadSecretById(accountId);
    const { tokens } = await this.oauthClient(account).getToken(code);

    if (!tokens.refresh_token) {
      throw new Error(
        'Google returned no refresh token; revoke the app at myaccount.google.com/permissions and authorise again',
      );
    }

    await this.accounts.update(accountId, {
      refreshToken: this.settings.seal(tokens.refresh_token),
    });
    this.log.log(`account ${account.label} connected`);
  }

  /** A channel's uploads playlist never changes, so it is learned once. */
  async rememberUploadsPlaylist(accountId: string, playlistId: string): Promise<void> {
    await this.accounts.update(accountId, { uploadsPlaylistId: playlistId });
  }

  refreshTokenOf(account: YtAccount): string | null {
    return account.refreshToken ? this.settings.openText(account.refreshToken) : null;
  }

  // --- cookies -------------------------------------------------------------

  /**
   * Stores a jar built from whatever DevTools was asked to copy, which is the
   * capture that needs nothing installed anywhere: a **Copy as cURL** of any
   * request to youtube.com, or the `cookie:` header on its own.
   *
   * The session is checked against YouTube before it is stored. A header copied
   * from a signed-out tab, or from a Google service that is not YouTube, yields
   * cookies that look right and authenticate nothing — storing that would only
   * be discovered on the day a file has to come back.
   */
  async storeCookieHeader(
    userId: string,
    accountId: string,
    paste: string,
  ): Promise<{ kept: number; dropped: number; domains: string[]; account: string | null }> {
    const { header, url } = cookieHeaderFromPaste(paste);

    // Copying the wrong row in DevTools is the likely mistake and looks like
    // nothing at all: a request to another host carries no YouTube cookies, so
    // there is no `cookie:` line to find and no cookies in its cURL. Naming the
    // host is the difference between a dead end and an obvious fix.
    const host = hostOf(url);
    if (host && !/(^|\.)youtube\.com$/.test(host)) {
      throw new Error(
        `that request went to ${host}, which receives no YouTube cookies. Copy a request to ` +
          'youtube.com instead, made by a youtube.com tab of its own — a row from a video ' +
          'embedded in another site carries only cross-site cookies, which do not authenticate.',
      );
    }

    const jar = jarFromHeader(header);

    const session = await identifySession(jar);
    if (session.checked && !session.loggedIn) {
      throw new Error(
        'YouTube does not accept those cookies: either they were copied from a signed-out tab, or ' +
          'the session has been rotated since — Google does that as the browser keeps using it, ' +
          'sometimes within minutes. Copy a fresh header, ideally from a private window you then ' +
          'close without signing out, and paste it straight away.',
      );
    }

    const stored = await this.storeCookies(userId, accountId, jar);
    return { ...stored, account: session.account };
  }

  async storeCookies(
    userId: string,
    accountId: string,
    cookiesTxt: Buffer,
  ): Promise<{ kept: number; dropped: number; domains: string[] }> {
    await this.loadSecret(userId, accountId);

    const { jar, kept, dropped, domains } = filterCookieJar(cookiesTxt);
    await this.accounts.update(accountId, {
      cookieJar: this.settings.seal(jar),
      cookieHealth: 'OK',
      cookieCheckedAt: new Date(),
    });

    this.log.log(`cookie jar stored: kept ${kept}, discarded ${dropped} unrelated`);
    return { kept, dropped, domains };
  }

  /**
   * Opens a browser on this machine against a throwaway profile, waits for a
   * YouTube sign-in, and stores what comes out — the wizard's last step as a
   * button rather than a command to paste elsewhere.
   *
   * Ownership is checked here, before anything is launched, so the capture that
   * a poll later reports on can only ever belong to the caller.
   */
  async startCookieCapture(
    userId: string,
    accountId: string,
    profile?: string,
  ): Promise<CaptureProgress> {
    await this.loadSecret(userId, accountId);
    const store = (jar: Buffer) => this.storeCookies(userId, accountId, jar);

    // A named profile is copied as it is; without one there is nothing signed
    // in to copy, so a throwaway is opened and the sign-in waited for.
    return profile
      ? this.capture.startFromProfile(accountId, profile, store)
      : this.capture.start(accountId, store);
  }

  /** The signed-in browser profiles on this machine, for the picker. */
  async captureProfiles(userId: string, accountId: string): Promise<BrowserProfile[]> {
    await this.loadSecret(userId, accountId);
    return listProfiles();
  }

  async cookieCaptureStatus(userId: string, accountId: string): Promise<CaptureProgress | null> {
    await this.loadSecret(userId, accountId);
    return this.capture.status(accountId);
  }

  async cancelCookieCapture(userId: string, accountId: string): Promise<void> {
    await this.loadSecret(userId, accountId);
    this.capture.stop(accountId);
  }

  /**
   * Pulls cookies out of a local browser profile via yt-dlp.
   *
   * Convenient, and a trap for the profile you actually browse with: Google
   * rotates session cookies on use, so a jar copied from a live profile is
   * rotated by two independent clients at once and the session is invalidated
   * within minutes. Measured here twice — jars taken this way died after
   * roughly twenty and five minutes respectively.
   *
   * Safe only for a browser profile that is then left alone. For a profile in
   * daily use, export from a private window and close it *without* logging
   * out: that produces a session the browser will never touch again.
   *
   * Also requires the API to share a machine with the browser, so it does
   * nothing inside a container.
   */
  async importFromBrowser(
    userId: string,
    accountId: string,
    browser: string,
  ): Promise<{ kept: number; dropped: number; domains: string[]; warning: string }> {
    if (!/^[a-z]+(:[\w .-]+)?$/i.test(browser)) throw new Error('invalid browser name');

    const dir = await mkdtemp(join(tmpdir(), 'ytimport-'));
    const file = join(dir, 'cookies.txt');
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          'yt-dlp',
          [
            '--cookies-from-browser', browser,
            '--cookies', file,
            '--simulate',
            '--no-warnings',
            'https://www.youtube.com/robots.txt',
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        proc.stderr.on('data', (chunk) => (stderr += chunk));
        proc.on('error', (error) =>
          reject(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? new Error('yt-dlp is not installed')
              : error,
          ),
        );
        // yt-dlp exits non-zero on the dummy URL but still writes the jar.
        proc.on('close', () =>
          existsSync(file) ? resolve() : reject(new Error(stderr.trim() || 'could not read that browser profile')),
        );
      });

      const result = await this.storeCookies(userId, accountId, await readFile(file));
      return {
        ...result,
        warning:
          `taken from the live ${browser} profile - if you keep browsing YouTube signed in there, ` +
          'this jar will be invalidated within minutes. For a profile in daily use, export from a ' +
          'private window instead and close it without logging out.',
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Decrypts an account's jar to a private temp file, runs `fn`, then re-seals
   * whatever yt-dlp left behind.
   *
   * The re-seal is the point: yt-dlp rotates session cookies as it runs and
   * writes them back to the file. Discarding that mutated copy is exactly what
   * makes cookie jars quietly expire after a few weeks.
   */
  async withCookies<T>(accountId: string, fn: (cookiePath: string) => Promise<T>): Promise<T> {
    // Serialised across processes: two concurrent rotations of the same jar
    // invalidate the Google session outright. See CookieLock.
    return this.lock.acquire(accountId, async () => {
      const account = await this.loadSecretById(accountId);
      if (!account.cookieJar) {
        throw new Error(`account ${account.label} has no cookie jar - upload one before downloading`);
      }

      const dir = await mkdtemp(join(tmpdir(), 'ytc-'));
      const file = join(dir, 'cookies.txt');
      await writeFile(file, this.settings.open(account.cookieJar), { mode: 0o600 });

      try {
        return await fn(file);
      } finally {
        try {
          const rotated = await readFile(file);
          // Only persist a jar that still carries a session cookie. yt-dlp can
          // leave a truncated file behind when it fails, and storing that
          // would destroy working credentials.
          if (rotated.length > 0 && hasSessionCookie(rotated)) {
            await this.accounts.update(accountId, { cookieJar: this.settings.seal(rotated) });
          } else if (rotated.length > 0) {
            this.log.warn('yt-dlp returned a jar with no session cookie; keeping the previous one');
          }
        } catch (error) {
          this.log.warn(`could not persist rotated cookies: ${(error as Error).message}`);
        }
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  async recordCookieHealth(accountId: string, ok: boolean): Promise<void> {
    const health: CookieHealth = ok ? 'OK' : 'STALE';
    await this.accounts.update(accountId, { cookieHealth: health, cookieCheckedAt: new Date() });
    if (!ok) {
      this.log.error(
        `account ${accountId}: cookie jar no longer authenticates - re-export it, private videos cannot be downloaded until you do`,
      );
    }
  }

  // --- quota ---------------------------------------------------------------

  /**
   * Picks an account that can actually complete an upload: connected, holding
   * cookies, and with quota left. Quota is per Cloud project, so each account
   * carries its own budget. The decision itself lives in `quota.ts`, where it
   * can be tested without a database.
   */
  async pickForUpload(userId: string): Promise<YtAccount> {
    const candidates = await this.accounts.find({ where: { userId }, select: WITH_SECRETS });
    if (candidates.length === 0) {
      throw new Error('no YouTube accounts configured - add one at POST /accounts');
    }

    const choice = selectUploadAccount(candidates);
    if ('reasons' in choice) {
      throw new Error(`no account can upload right now (${choice.reasons.join('; ')})`);
    }
    return choice.account;
  }

  /**
   * `quotaResetAt` moves only when the upload opens a new Pacific day, because
   * it is the anchor that `quotaIsStale` compares against: rewriting it on
   * every upload would keep pushing the day forward and the counter would
   * never clear.
   */
  async recordUpload(accountId: string): Promise<void> {
    const account = await this.loadSecretById(accountId);
    const stale = quotaIsStale(account);
    await this.accounts.update(accountId, {
      uploadsToday: (stale ? 0 : account.uploadsToday) + 1,
      ...(stale ? { quotaResetAt: new Date() } : {}),
    });
  }

  quotaSummary(account: YtAccount): {
    uploadsUsed: number;
    uploadsLeft: number;
    dailyLimit: number;
  } {
    return quotaSummary(account);
  }
}

/** The host of a URL, or null for anything that is not one. */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
