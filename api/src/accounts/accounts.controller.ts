import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../auth/user.entity';
import { UNVERIFIED_MAX_VIDEO_SECONDS, VERIFIED_MAX_VIDEO_SECONDS } from '../youtube/constants';
import { AccountsService, isReturnTarget, parseOAuthState } from './accounts.service';

class ImportCookiesDto {
  @IsString()
  @IsNotEmpty()
  browser!: string;
}

/**
 * The paste, out of whatever shape it arrived in.
 *
 * `{ header }` is what the page sends. A bare string is what a curl or a
 * client sending `text/plain` produces, and accepting it costs one line — the
 * alternative is a 400 that blames the person for an empty paste that was not
 * empty.
 */
function pasteOf(body: unknown): string | null {
  if (typeof body === 'string' && body.trim() !== '') return body;
  if (body && typeof body === 'object') {
    const value = (body as { header?: unknown }).header;
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * The bytes of the request, when the parsed body came back empty.
 *
 * A paste is a few kilobytes; the cap is there because this reads an unparsed
 * stream and something has to say no. Reading it is safe precisely because the
 * parsed body was empty — nothing else has consumed it.
 */
async function rawBody(request: Request, limit = 512 * 1024): Promise<unknown> {
  if (request.readableEnded) return null;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return null;

  // JSON when it looks like it, the paste itself when it does not.
  try {
    return text.startsWith('{') ? JSON.parse(text) : text;
  } catch {
    return text;
  }
}

/** What arrived instead, in enough detail to act on and with no secret in it. */
function describe(body: unknown): string {
  if (body === undefined || body === null) return 'no body at all';
  if (typeof body === 'string') return body.trim() === '' ? 'an empty string' : 'a string';
  if (typeof body === 'object') {
    const keys = Object.keys(body as object);
    return keys.length ? `an object with keys: ${keys.join(', ')}` : 'an empty object';
  }
  return `a ${typeof body}`;
}

/**
 * `profile` is an id from the list above, like `brave:Default`. Optional
 * because without one the capture falls back to opening a throwaway profile and
 * waiting for a sign-in, which is what the one-off script does.
 */
class StartCaptureDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  profile?: string;
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

  /**
   * The verified switch. It decides how long a video this channel accepts, and
   * therefore whether a large file is stored whole or split across several.
   *
   * Asserted by the operator because YouTube offers no way to ask: the only
   * test is an upload, and an upload that is too long is accepted, abandoned
   * mid-transcode and deleted.
   */
  @Post(':id/verified')
  @UseGuards(SessionGuard)
  async setVerified(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: { verified?: boolean },
  ) {
    const account = await this.accounts.setVerified(user.id, id, Boolean(body.verified));
    return {
      id: account.id,
      verified: account.verified,
      maxVideoSeconds: account.verified ? VERIFIED_MAX_VIDEO_SECONDS : UNVERIFIED_MAX_VIDEO_SECONDS,
    };
  }

  @Get(':id/connect')
  @UseGuards(SessionGuard)
  async connect(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('return') returnTo?: string,
  ) {
    const account = await this.accounts.loadSecret(user.id, id);
    res.redirect(this.accounts.authUrl(account, isReturnTarget(returnTo) ? returnTo : 'accounts'));
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

    const { accountId, returnTo } = parseOAuthState(state);
    await this.accounts.completeOAuth(accountId, code);

    // Google lands a person's browser here, so it should end up somewhere a
    // person can use — the page they started from. Same origin, so the path is
    // enough, and `returnTo` is one of a fixed set rather than anything the
    // round trip carried back.
    res.redirect(returnTo);
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
   * Stores a jar built from a `cookie:` request header pasted into the page.
   *
   * The capture that needs nothing installed: DevTools shows that header on any
   * youtube.com request, `HttpOnly` cookies included, and one copy carries the
   * whole session.
   */
  @Post(':id/cookies/header')
  @UseGuards(SessionGuard)
  async cookieHeader(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    // Read by hand rather than through a DTO, and from the raw stream when the
    // parsed body is empty. Express only parses what its content-type says it
    // is, so a paste sent as anything but JSON arrives as nothing — and the
    // person doing the pasting is told their paste was empty when it was not.
    // Whatever the client called it, the bytes are there.
    const paste = pasteOf(body) ?? pasteOf(await rawBody(request));
    if (paste === null) {
      throw new BadRequestException(
        `expected {"header": "…"} — got ${describe(body)} with content-type ` +
          `${request.headers['content-type'] ?? 'none'}. Reload the page and paste again.`,
      );
    }

    try {
      return await this.accounts.storeCookieHeader(user.id, id, paste);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /**
   * The browser profiles on the API's machine that are already signed in to
   * Google — what the picker in the page lists.
   *
   * Empty is a normal answer, not an error: it means no profile here holds a
   * Google session, and the page says so rather than offering a button that
   * would fail.
   */
  @Get(':id/cookies/capture/profiles')
  @UseGuards(SessionGuard)
  async captureProfiles(@CurrentUser() user: User, @Param('id') id: string) {
    return { profiles: await this.accounts.captureProfiles(user.id, id) };
  }

  /**
   * Takes the jar out of the chosen profile and stores it — the wizard step as
   * one button.
   *
   * Returns immediately with the first state rather than holding the request
   * open while yt-dlp decrypts a profile and Google is asked whose it is; `GET`
   * below is how the page follows along, and `DELETE` gives up.
   */
  @Post(':id/cookies/capture')
  @UseGuards(SessionGuard)
  async startCapture(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: StartCaptureDto,
  ) {
    try {
      return await this.accounts.startCookieCapture(user.id, id, dto?.profile);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Get(':id/cookies/capture')
  @UseGuards(SessionGuard)
  async captureStatus(@CurrentUser() user: User, @Param('id') id: string) {
    return (await this.accounts.cookieCaptureStatus(user.id, id)) ?? { state: 'IDLE' };
  }

  @Delete(':id/cookies/capture')
  @UseGuards(SessionGuard)
  async cancelCapture(@CurrentUser() user: User, @Param('id') id: string) {
    await this.accounts.cancelCookieCapture(user.id, id);
    return { cancelled: id };
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
