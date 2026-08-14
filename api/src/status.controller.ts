import { Controller, Get, UseGuards } from '@nestjs/common';
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
    };
  }
}
