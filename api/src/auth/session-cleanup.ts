import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuthService } from './auth.service';

/** Expired sessions are dead rows; nothing else ever deletes them. */
@Injectable()
export class SessionCleanup {
  private readonly log = new Logger(SessionCleanup.name);

  constructor(private readonly auth: AuthService) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purge(): Promise<void> {
    await this.auth.purgeExpired();
    this.log.debug('expired sessions purged');
  }
}
