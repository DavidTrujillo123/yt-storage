import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthService, MIN_PASSWORD_LENGTH, SESSION_COOKIE } from './auth.service';
import { SessionGuard } from './session.guard';
import { CurrentUser } from './current-user.decorator';
import type { User } from './user.entity';
import { SettingsService } from '../common/settings.service';
import { DEFAULT_ADMIN_SETTING } from './admin-seed';

class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  password!: string;
}

/**
 * No length rule, deliberately: a short password must be answered with "wrong
 * email or password" like any other wrong one. Validating it here would both
 * lock out accounts predating the current minimum and announce the policy to
 * anyone guessing.
 */
class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * What the login page needs before anyone is signed in: whether it should
   * offer a register form, and whether this instance is still on the shipped
   * credential. The latter is unauthenticated on purpose — it discloses only a
   * password that is printed in the README, and only while it still works.
   */
  @Get('bootstrap')
  async bootstrap() {
    return {
      registrationOpen: await this.auth.registrationOpen(),
      defaultAdmin: await this.settings.get(DEFAULT_ADMIN_SETTING),
      minPasswordLength: MIN_PASSWORD_LENGTH,
    };
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.register(dto.email, dto.password);
    await this.issue(res, dto.email, dto.password);
    return { id: user.id, email: user.email };
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    await this.issue(res, dto.email, dto.password);
    return { ok: true };
  }

  @Post('password')
  @UseGuards(SessionGuard)
  async changePassword(
    @CurrentUser() user: User,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword, token);

    // The shipped credential is retired the moment it stops being the password,
    // which is what takes it off the login page.
    await this.settings.delete(DEFAULT_ADMIN_SETTING);
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
