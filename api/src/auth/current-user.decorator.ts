import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthedRequest } from './session.guard';
import type { User } from './user.entity';

/** Reads the user the SessionGuard put on the request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User =>
    context.switchToHttp().getRequest<AuthedRequest>().user,
);
