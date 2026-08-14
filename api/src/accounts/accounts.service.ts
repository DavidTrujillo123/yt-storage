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
import { filterCookieJar, hasSessionCookie } from './cookie-jar';
import { CookieLock } from './cookie-lock';
import { quotaIsStale, quotaSummary, selectUploadAccount } from './quota';
import { OAUTH_SCOPES, UPLOAD_QUOTA_COST } from '../youtube/constants';

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
  quotaUsed: true,
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
   * accounts it is completing.
   */
  authUrl(account: YtAccount): string {
    return this.oauthClient(account).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: OAUTH_SCOPES,
      state: account.id,
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

  refreshTokenOf(account: YtAccount): string | null {
    return account.refreshToken ? this.settings.openText(account.refreshToken) : null;
  }

  // --- cookies -------------------------------------------------------------

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

  async chargeQuota(accountId: string, units = UPLOAD_QUOTA_COST): Promise<void> {
    const account = await this.loadSecretById(accountId);
    const stale = quotaIsStale(account);
    await this.accounts.update(accountId, {
      quotaUsed: (stale ? 0 : account.quotaUsed) + units,
      ...(stale ? { quotaResetAt: new Date() } : {}),
    });
  }

  quotaSummary(account: YtAccount): { used: number; remaining: number; uploadsLeft: number } {
    return quotaSummary(account);
  }
}
