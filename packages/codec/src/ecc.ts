import { createRequire } from 'node:module';
import type { ReedSolomonModule } from '@ronomon/reed-solomon';
import { RS_K, RS_M, SHARD_BYTES } from './geometry.ts';

// The package's entry point is a raw .node binding, which ESM cannot import.
const ReedSolomon = createRequire(import.meta.url)(
  '@ronomon/reed-solomon',
) as ReedSolomonModule;

/**
 * Erasure coding across frames.
 *
 * Every frame carries a CRC, so a damaged frame is *detected* rather than
 * silently wrong — which turns corruption into an erasure, the case Reed-Solomon
 * handles best. Any 6 of the 30 frames in a group can be lost outright.
 */
const context = ReedSolomon.create(RS_K, RS_M);

const ALL_DATA = 2 ** RS_K - 1;
const ALL_PARITY = (2 ** RS_M - 1) << RS_K;

function run(sources: number, targets: number, data: Buffer, parity: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    ReedSolomon.encode(
      context,
      sources,
      targets,
      data,
      0,
      data.length,
      parity,
      0,
      parity.length,
      (error: Error | null) => (error ? reject(error) : resolve()),
    );
  });
}

/** Takes RS_K data shards, returns RS_M parity shards. */
export async function encodeGroup(dataShards: Buffer[]): Promise<Buffer[]> {
  if (dataShards.length !== RS_K) throw new Error(`expected ${RS_K} data shards`);

  const data = Buffer.concat(dataShards);
  const parity = Buffer.alloc(RS_M * SHARD_BYTES);
  await run(ALL_DATA, ALL_PARITY, data, parity);

  return Array.from({ length: RS_M }, (_, i) =>
    parity.subarray(i * SHARD_BYTES, (i + 1) * SHARD_BYTES),
  );
}

/**
 * Rebuilds the RS_K data shards from whatever survived. `shards` is indexed
 * 0..RS_K+RS_M-1 with null for every frame that was lost or failed its CRC.
 */
export async function recoverGroup(shards: (Buffer | null)[]): Promise<Buffer[]> {
  const present = shards.filter(Boolean).length;
  if (present < RS_K) {
    throw new Error(`unrecoverable: ${present} of ${RS_K} shards needed`);
  }

  const data = Buffer.alloc(RS_K * SHARD_BYTES);
  const parity = Buffer.alloc(RS_M * SHARD_BYTES);
  let sources = 0;
  let targets = 0;

  for (let i = 0; i < RS_K; i++) {
    if (shards[i]) {
      shards[i]!.copy(data, i * SHARD_BYTES);
      sources |= 1 << i;
    } else {
      targets |= 1 << i;
    }
  }
  for (let i = 0; i < RS_M; i++) {
    const shard = shards[RS_K + i];
    if (shard) {
      shard.copy(parity, i * SHARD_BYTES);
      sources |= 1 << (RS_K + i);
    }
  }

  if (targets !== 0) await run(sources, targets, data, parity);

  return Array.from({ length: RS_K }, (_, i) =>
    data.subarray(i * SHARD_BYTES, (i + 1) * SHARD_BYTES),
  );
}
