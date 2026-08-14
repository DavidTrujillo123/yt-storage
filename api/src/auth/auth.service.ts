import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { Session, User } from './user.entity';

export const SESSION_COOKIE = 'yts_session';
const SESSION_DAYS = 30;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Open while the instance has no users, so the owner can create the first
   * account without a bootstrap script, then closed unless explicitly enabled.
   * A self-hosted box reachable over Tailscale should not accept strangers by
   * default.
   */
  async registrationOpen(): Promise<boolean> {
    if (this.config.get<string>('ALLOW_REGISTRATION') === 'true') return true;
    return (await this.users.count()) === 0;
  }

  async register(email: string, password: string): Promise<User> {
    if (!(await this.registrationOpen())) {
      throw new UnauthorizedException('registration is closed on this instance');
    }
    if (password.length < 12) {
      throw new ConflictException('password must be at least 12 characters');
    }

    const normalised = email.trim().toLowerCase();
    if (await this.users.findOne({ where: { email: normalised } })) {
      throw new ConflictException('that email is already registered');
    }

    const user = this.users.create({
      email: normalised,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    });
    return this.users.save(user);
  }

  async login(email: string, password: string): Promise<{ token: string; expiresAt: Date }> {
    const user = await this.users.findOne({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true, passwordHash: true },
    });

    // Verify against a dummy hash when the user does not exist so that a
    // missing account and a wrong password take the same time to answer.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('wrong email or password');

    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    const session = await this.sessions.save(
      this.sessions.create({ token: randomBytes(32).toString('base64url'), userId: user.id, expiresAt }),
    );
    return { token: session.token, expiresAt };
  }

  async resolve(token: string): Promise<User | null> {
    const session = await this.sessions.findOne({ where: { token }, relations: { user: true } });
    if (!session) return null;

    if (session.expiresAt.getTime() < Date.now()) {
      await this.sessions.delete({ token });
      return null;
    }
    return session.user;
  }

  async logout(token: string): Promise<void> {
    await this.sessions.delete({ token });
  }

  async purgeExpired(): Promise<void> {
    await this.sessions.delete({ expiresAt: LessThan(new Date()) });
  }
}

/** A real Argon2id hash of a value nobody knows, used to equalise login timing. */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$8bB1M0kFJkQmZ0ImU0hQZ0Z0aGlzaXNub3RyZWFs';
