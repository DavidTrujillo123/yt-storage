import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from './setting.entity';
import { SecretBox } from './secret-box';

/**
 * Key/value store plus the app's one encryption key.
 *
 * Anything that would let someone act as the user on Google — refresh tokens,
 * client secrets, cookie jars — goes through `seal`/`open` before it is
 * written anywhere.
 */
@Injectable()
export class SettingsService {
  private readonly box: SecretBox;

  constructor(
    @InjectRepository(Setting) private readonly settings: Repository<Setting>,
    config: ConfigService,
  ) {
    this.box = new SecretBox(config.get<string>('SECRET_KEY', ''));
  }

  async get(key: string): Promise<string | null> {
    const row = await this.settings.findOne({ where: { key } });
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.settings.upsert({ key, value }, ['key']);
  }

  async delete(key: string): Promise<void> {
    await this.settings.delete({ key });
  }

  seal(value: Buffer | string): string {
    return this.box.seal(value).toString('base64');
  }

  open(value: string): Buffer {
    return this.box.open(Buffer.from(value, 'base64'));
  }

  openText(value: string): string {
    return this.open(value).toString('utf8');
  }
}
