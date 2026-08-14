import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { SessionGuard } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import type { User } from './user.entity';

class CredentialsDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('registration')
  async registration() {
    return { open: await this.auth.registrationOpen() };
  }

  @Post('register')
  async register(@Body() dto: CredentialsDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.register(dto.email, dto.password);
    await this.issue(res, dto.email, dto.password);
    return { id: user.id, email: user.email };
  }

  @Post('login')
  async login(@Body() dto: CredentialsDto, @Res({ passthrough: true }) res: Response) {
    await this.issue(res, dto.email, dto.password);
    return { ok: true };
  }

  @Post('logout')
  @UseGuards(SessionGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) await this.auth.logout(token);
    res.clearCookie(SESSION_COOKIE);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email };
  }

  /**
   * `secure` is deliberately off: this runs over plain HTTP on a home network
   * or a Tailscale address, where a secure-only cookie would never be sent and
   * login would appear to silently fail. Put it behind TLS and turn it on.
   */
  private async issue(res: Response, email: string, password: string): Promise<void> {
    const { token, expiresAt } = await this.auth.login(email, password);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });
  }
}
