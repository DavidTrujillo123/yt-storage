import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../common/settings.service';
import { AuthService } from './auth.service';

export const DEFAULT_ADMIN_EMAIL = 'admin@yt-storage.com';
export const DEFAULT_ADMIN_PASSWORD = 'Abcd1234';

/**
 * The setting that says "this instance is still on its shipped password".
 *
 * Its presence is what puts the credential on the login page and the warning in
 * the log; changing the password deletes it. Nothing reads the password itself
 * to decide — a stored flag costs nothing, and verifying an argon2 hash on every
 * anonymous page load would.
 */
export const DEFAULT_ADMIN_SETTING = 'auth.defaultAdmin';

/**
 * Creates the administrator so that `docker compose up` lands on a usable app.
 *
 * Keyed on the email, not on the table being empty: if the account is deleted it
 * comes back on the next restart, and if it exists its password is left exactly
 * as it is. Restarting is therefore never destructive.
 *
 * The convenience is real and so is the exposure — this account holds cookie
 * jars that authenticate every Google service, not just YouTube. Hence the
 * warning on every boot until the password changes, and SEED_ADMIN=false for
 * anyone who wants none of it.
 */
@Injectable()
export class AdminSeed implements OnApplicationBootstrap {
  private readonly log = new Logger(AdminSeed.name);

  constructor(
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('SEED_ADMIN', 'true') !== 'true') return;

    const email = this.config.get<string>('ADMIN_EMAIL', DEFAULT_ADMIN_EMAIL);
    const password = this.config.get<string>('ADMIN_PASSWORD', DEFAULT_ADMIN_PASSWORD);

    if (await this.auth.ensureUser(email, password)) {
      this.log.log(`seeded the administrator ${email}`);
      // Only advertise a password that is public knowledge anyway. One set in
      // the environment is the operator's own, and belongs on no page.
      if (password === DEFAULT_ADMIN_PASSWORD) {
        await this.settings.set(DEFAULT_ADMIN_SETTING, email);
      }
    }

    if (await this.settings.get(DEFAULT_ADMIN_SETTING)) {
      this.log.warn(
        `${email} is still using the default password. Anyone who can reach this ` +
          'instance can sign in and read the Google credentials it holds - change it at /setup.',
      );
    }
  }
}
