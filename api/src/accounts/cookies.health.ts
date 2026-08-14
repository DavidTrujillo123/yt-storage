import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { YtAccount } from './yt-account.entity';
import { AccountsService } from './accounts.service';
import { FilesService } from '../files/files.service';
import { YtdlpService } from '../youtube/ytdlp.service';

/**
 * Cookie jars die quietly. Without a scheduled probe you find out on the day
 * you need a file back, which is the worst possible moment — so every account
 * with a jar is checked twice a day against a video it already stores, and
 * flipped to STALE before it matters.
 */
@Injectable()
export class CookiesHealthCheck {
  private readonly log = new Logger(CookiesHealthCheck.name);

  constructor(
    @InjectRepository(YtAccount) private readonly accounts: Repository<YtAccount>,
    private readonly accountsService: AccountsService,
    private readonly files: FilesService,
    private readonly ytdlp: YtdlpService,
  ) {}

  @Cron(CronExpression.EVERY_12_HOURS)
  async check(): Promise<void> {
    const withJars = await this.accounts.find({
      where: { cookieHealth: Not('MISSING') },
      select: { id: true, label: true },
    });

    for (const account of withJars) {
      const probe = await this.files.probeFor(account.id);
      if (!probe?.videoId) {
        this.log.debug(`${account.label}: no stored video to probe with yet`);
        continue;
      }
      await this.accountsService.recordCookieHealth(
        account.id,
        await this.ytdlp.checkAuth(account.id, probe.videoId),
      );
    }
  }
}
