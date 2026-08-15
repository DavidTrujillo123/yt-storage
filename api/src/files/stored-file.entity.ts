import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../auth/user.entity';
import { YtAccount } from '../accounts/yt-account.entity';

export type FileStatus =
  | 'PENDING'
  | 'ENCODING'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'VERIFYING'
  | 'READY'
  | 'FAILED';

/**
 * One stored file and where it currently sits in the pipeline.
 *
 * status moves: PENDING -> ENCODING -> UPLOADING -> PROCESSING -> VERIFYING
 *               -> READY, or FAILED at any point.
 *
 * The local source file is only deleted once VERIFYING has round-tripped the
 * video back off YouTube and matched the hash. Until then this row points at
 * the only good copy.
 */
@Entity('stored_files')
@Index(['userId', 'status'])
export class StoredFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  userId!: string;

  @ManyToOne(() => User, (user) => user.files, { onDelete: 'CASCADE' })
  user!: User;

  @Column({ type: 'text', nullable: true })
  ytAccountId!: string | null;

  @ManyToOne(() => YtAccount, (account) => account.files, { onDelete: 'SET NULL', nullable: true })
  ytAccount!: YtAccount | null;

  @Column()
  name!: string;

  /**
   * Null only on a row imported back from the channel, where the original size
   * is not knowable without decoding the video — the description carries the
   * name and the hash, not the length. A zero would render as an empty file;
   * null renders as "not measured yet" and is corrected on the first download.
   */
  @Column({ type: 'integer', nullable: true })
  size!: number | null;

  @Column()
  sha256!: string;

  @Index()
  @Column({ type: 'varchar', default: 'PENDING' })
  status!: FileStatus;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** Original upload, removed after verification succeeds. */
  @Column({ type: 'text', nullable: true })
  sourcePath!: string | null;

  /** Encoded .mp4, removed once YouTube has it. */
  @Column({ type: 'text', nullable: true })
  videoPath!: string | null;

  @Column({ type: 'text', nullable: true })
  videoId!: string | null;

  @Column({ type: 'integer', nullable: true })
  frames!: number | null;

  @Column({ type: 'integer', nullable: true })
  videoBytes!: number | null;

  /** Progress of the current stage, 0-100. */
  @Column({ type: 'integer', default: 0 })
  progress!: number;

  /**
   * How many times verification has asked YouTube for this video, and when it
   * last asked. Both lived only inside BullMQ before, which meant a file could
   * sit in the same state for a day with nothing to say whether anything was
   * still happening to it.
   */
  @Column({ type: 'integer', default: 0 })
  verifyAttempts!: number;

  @Column({ type: 'datetime', nullable: true })
  lastCheckedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  verifiedAt!: Date | null;

  /**
   * Set on a row rebuilt from the channel rather than uploaded through here,
   * and cleared the first time the file is downloaded.
   *
   * Until then `name` and `sha256` are only what the video's description says
   * they are, and `size` is unknown. That is worth marking: the restore path
   * refuses a file whose decoded hash disagrees with the stored one, which is
   * right for a row this instance wrote and wrong for a row it merely read off
   * YouTube — there the decode is the authority, not the row.
   */
  @Column({ type: 'datetime', nullable: true })
  importedAt!: Date | null;
}
