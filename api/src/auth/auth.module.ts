import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session, User } from './user.entity';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SessionGuard } from './session.guard';
import { SessionCleanup } from './session-cleanup';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, Session])],
  controllers: [AuthController],
  providers: [AuthService, SessionGuard, SessionCleanup],
  exports: [AuthService, SessionGuard],
})
export class AuthModule {}
