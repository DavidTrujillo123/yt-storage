import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Key/value store for anything not worth a table. */
@Entity('settings')
export class Setting {
  @PrimaryColumn()
  key!: string;

  @Column({ type: 'text' })
  value!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
