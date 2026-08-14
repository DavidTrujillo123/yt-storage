import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { YtAccount } from '../accounts/yt-account.entity';
import { StoredFile } from '../files/stored-file.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  /** Argon2id. Never selected unless explicitly asked for. */
  @Column({ select: false })
  passwordHash!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToMany(() => YtAccount, (account) => account.user)
  accounts!: YtAccount[];

  @OneToMany(() => StoredFile, (file) => file.user)
  files!: StoredFile[];
}

/**
 * Opaque bearer token in an httpOnly cookie. Cheaper than a JWT here: logging
 * out means deleting a row, with no revocation list to maintain.
 */
@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  token!: string;

  @Index()
  @Column()
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user!: User;

  @Column({ type: 'datetime' })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
