import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, SESSION_COOKIE } from './auth.service';
import type { User } from './user.entity';

export interface AuthedRequest extends Request {
  user: User;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) throw new UnauthorizedException('not signed in');

    const user = await this.auth.resolve(token);
    if (!user) throw new UnauthorizedException('session expired');

    request.user = user;
    return true;
  }
}
