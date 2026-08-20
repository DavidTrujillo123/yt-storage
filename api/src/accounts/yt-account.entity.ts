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

  /**
   * Whether the channel has verified a phone number, which is the difference
   * between a fifteen-minute video and a twelve-hour one.
   *
   * Set by the operator rather than detected: YouTube exposes no API that says
   * "this channel is verified", and the only way to find out by experiment is
   * to upload something too long — which succeeds, wastes the bandwidth, and
   * then has its transcode abandoned. So it is a switch, and it decides whether
   * a large file is stored as one video or split across several.
   */
  @Column({ type: 'boolean', default: false })
  verified!: boolean;

  /**
   * Whether Google granted the write scope, which renaming and deleting on
   * YouTube both need and uploading does not.
   *
   * Read from the token response at connect time rather than assumed from
   * what was asked for: an account authorised before this app requested the
   * scope keeps working for everything else, and the honest answer is what the
   * consent actually returned. It is also the only way the UI can say "reconnect
   * to enable this" instead of failing when someone tries.
   */
  @Column({ type: 'boolean', default: false })
  canManage!: boolean;

  @Column({ type: 'datetime', nullable: true })
  cookieCheckedAt!: Date | null;

  /** Uploads made in the Pacific day that `quotaResetAt` falls in, of 100. */
  @Column({ type: 'integer', default: 0 })
  uploadsToday!: number;

  /** Anchors which Pacific day `uploadsToday` counts; see `quotaIsStale`. */
  @Column({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  quotaResetAt!: Date;

  /**
   * The channel's uploads playlist, learned the first time the catalogue is
   * rebuilt from it. A channel's is fixed for its lifetime, so remembering it
   * saves a `channels.list` on every later import.
   */
  @Column({ type: 'text', nullable: true })
  uploadsPlaylistId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToMany(() => StoredFile, (file) => file.ytAccount)
  files!: StoredFile[];
}
