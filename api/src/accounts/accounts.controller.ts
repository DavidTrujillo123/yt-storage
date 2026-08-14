import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsNotEmpty, IsString } from 'class-validator';
import type { Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../auth/user.entity';
import { AccountsService } from './accounts.service';

class ImportCookiesDto {
  @IsString()
  @IsNotEmpty()
  browser!: string;
}

class CreateAccountDto {
  @IsString()
  @IsNotEmpty()
  label!: string;

  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  clientSecret!: string;
}

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @UseGuards(SessionGuard)
  async list(@CurrentUser() user: User) {
    const accounts = await this.accounts.summarise(user.id);
    return accounts;
  }

  @Post()
  @UseGuards(SessionGuard)
  async create(@CurrentUser() user: User, @Body() dto: CreateAccountDto) {
    const account = await this.accounts.create(user.id, dto);
    return { id: account.id, label: account.label, connected: false };
  }

  @Delete(':id')
  @UseGuards(SessionGuard)
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    await this.accounts.remove(user.id, id);
    return { deleted: id };
  }

  @Get(':id/connect')
  @UseGuards(SessionGuard)
  async connect(@CurrentUser() user: User, @Param('id') id: string, @Res() res: Response) {
    const account = await this.accounts.loadSecret(user.id, id);
    res.redirect(this.accounts.authUrl(account));
  }

  /**
   * Google's redirect lands here with no session cookie guarantee, so the
   * account is identified by the `state` value the authorise step set — not by
   * the signed-in user.
   */
  @Get('callback')
  async callback(
    @Res({ passthrough: true }) res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    if (error) throw new BadRequestException(`Google returned: ${error}`);
    if (!code || !state) throw new BadRequestException('missing code or state in the callback');

    await this.accounts.completeOAuth(state, code);

    // Google lands a person's browser here, so it should end up somewhere a
    // person can use. Same origin, so the path is enough.
    res.redirect('/accounts?connected=1');
  }

  @Post(':id/cookies')
  @UseGuards(SessionGuard)
  @UseInterceptors(FileInterceptor('file'))
  async cookies(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @UploadedFile() upload?: Express.Multer.File,
  ) {
    if (!upload?.buffer) throw new BadRequestException('no cookies.txt in the request');
    try {
      return await this.accounts.storeCookies(user.id, id, upload.buffer);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /**
   * Reads cookies out of a local browser profile instead of asking for a file.
   * Only works when the API shares a machine with the browser.
   */
  @Post(':id/cookies/from-browser')
  @UseGuards(SessionGuard)
  async cookiesFromBrowser(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: ImportCookiesDto,
  ) {
    try {
      return await this.accounts.importFromBrowser(user.id, id, dto.browser);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
}
