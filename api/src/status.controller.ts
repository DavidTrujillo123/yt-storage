import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionGuard } from './auth/session.guard';
import { CurrentUser } from './auth/current-user.decorator';
import type { User } from './auth/user.entity';
import { AccountsService } from './accounts/accounts.service';
import { FilesService } from './files/files.service';

@Controller('status')
@UseGuards(SessionGuard)
export class StatusController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly files: FilesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * One call that answers "can this thing store and retrieve a file right now"
   * — every account's credentials plus what today's upload budget looks like.
   */
  @Get()
  async status(@CurrentUser() user: User) {
    const accounts = await this.accounts.summarise(user.id);
    const counts = await this.files.countByStatus(user.id);
    const ready = accounts.filter((account) => account.ready);

    return {
      accounts,
      canUpload: ready.some((account) => account.quota.uploadsLeft > 0),
      uploadsLeftToday: ready.reduce((total, account) => total + account.quota.uploadsLeft, 0),
      files: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
      // Reported so the UI can compare it against the address the browser is
      // actually on. A mismatch here is invisible until Google refuses the
      // callback with redirect_uri_mismatch, and it is the single most common
      // way a deployment on a real host fails.
      redirectUri: this.config.get<string>(
        'GOOGLE_REDIRECT_URI',
        'http://localhost:3000/accounts/callback',
      ),
    };
  }
}
