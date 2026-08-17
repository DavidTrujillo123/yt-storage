import { createRequire } from 'node:module';
import type { ReedSolomonModule } from '@ronomon/reed-solomon';
import { RS_K, RS_M } from './geometry.ts';

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

/**
 * Takes RS_K data shards, returns RS_M parity shards.
 *
 * The shard size comes from the shards themselves rather than a constant:
 * how many bytes a frame holds is a property of the layout that wrote it, and
 * this layer only needs them all to be the same length.
 */
export async function encodeGroup(dataShards: Buffer[]): Promise<Buffer[]> {
  if (dataShards.length !== RS_K) throw new Error(`expected ${RS_K} data shards`);
  const size = shardSize(dataShards);
  const parity = await encodeGroupBytes(Buffer.concat(dataShards), size);
  return Array.from({ length: RS_M }, (_, i) => parity.subarray(i * size, (i + 1) * size));
}

/**
 * The same, for a group that is already one contiguous buffer.
 *
 * Which is how the encoder reads it: a group is `RS_K * shardBytes` of the
 * stream in order, so slicing it into shards and concatenating them back
 * together was 1.5 MiB copied per group — four hundred times over for a
 * six-hundred-megabyte file — to rebuild bytes that were already adjacent.
 *
 * The parity comes back as one buffer too. The caller wants to write each
 * shard as its own frame, and a subarray of this is that shard.
 */
export async function encodeGroupBytes(group: Buffer, shardBytes: number): Promise<Buffer> {
  if (group.length !== RS_K * shardBytes) {
    throw new Error(`a group of ${RS_K} shards of ${shardBytes} is not ${group.length} bytes`);
  }
  if (shardBytes % 8 !== 0) throw new Error(`shard size ${shardBytes} is not a multiple of 8`);

  const parity = Buffer.alloc(RS_M * shardBytes);
  await run(ALL_DATA, ALL_PARITY, group, parity);
  return parity;
}

/** The one length every shard in a group must share, and a multiple of 8. */
function shardSize(shards: (Buffer | null)[]): number {
  const first = shards.find((shard) => shard !== null);
  if (!first) throw new Error('a group with no shards has no size');
  for (const shard of shards) {
    if (shard && shard.length !== first.length) {
      throw new Error(`shards of different sizes: ${first.length} and ${shard.length}`);
    }
  }
  if (first.length % 8 !== 0) throw new Error(`shard size ${first.length} is not a multiple of 8`);
  return first.length;
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

  const size = shardSize(shards);
  const data = Buffer.alloc(RS_K * size);
  const parity = Buffer.alloc(RS_M * size);
  let sources = 0;
  let targets = 0;

  for (let i = 0; i < RS_K; i++) {
    if (shards[i]) {
      shards[i]!.copy(data, i * size);
      sources |= 1 << i;
    } else {
      targets |= 1 << i;
    }
  }
  for (let i = 0; i < RS_M; i++) {
    const shard = shards[RS_K + i];
    if (shard) {
      shard.copy(parity, i * size);
      sources |= 1 << (RS_K + i);
    }
  }

  if (targets !== 0) await run(sources, targets, data, parity);

  return Array.from({ length: RS_K }, (_, i) =>
    data.subarray(i * size, (i + 1) * size),
  );
}
