import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../auth/user.entity';
import { StoredFile } from '../files/stored-file.entity';

export type CookieHealth = 'MISSING' | 'OK' | 'STALE';

/**
 * One YouTube channel plus the Google Cloud project that uploads to it.
 *
 * Both halves matter. Quota is charged per *Cloud project*, not per channel, so
 * a second channel only adds capacity if it brings its own project — which is
 * why the client credentials live here rather than in the environment.
 *
 * Every secret on this entity is encrypted with SECRET_KEY before storage and
 * excluded from default selects, so a stray `find()` cannot leak one into a
 * response or a log line.
 */
@Entity('yt_accounts')
@Unique(['userId', 'label'])
export class YtAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  userId!: string;

  @ManyToOne(() => User, (user) => user.accounts, { onDelete: 'CASCADE' })
  user!: User;

  @Column()
  label!: string;

  @Column()
  clientId!: string;

  @Column({ select: false })
  clientSecret!: string;

  @Column({ type: 'text', nullable: true, select: false })
  refreshToken!: string | null;

  /** Netscape cookies.txt, needed because API uploads are locked to private. */
  @Column({ type: 'text', nullable: true, select: false })
  cookieJar!: string | null;

  @Column({ type: 'varchar', default: 'MISSING' })
  cookieHealth!: CookieHealth;

  @Column({ type: 'datetime', nullable: true })
  cookieCheckedAt!: Date | null;

  /** Quota units spent today. videos.insert costs 1,600 of 10,000. */
  @Column({ type: 'integer', default: 0 })
  quotaUsed!: number;

  @Column({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  quotaResetAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToMany(() => StoredFile, (file) => file.ytAccount)
  files!: StoredFile[];
}
