import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { crc32 } from '../src/crc32.ts';
import { pack, unpack } from '../src/container.ts';
import { encodeGroup, recoverGroup } from '../src/ecc.ts';
import { buildHeader, decodeFrame, renderFrame, sampleFrame } from '../src/frame.ts';
import { GROUP_FRAMES, HEIGHT, RS_K, RS_M, WIDTH } from '../src/geometry.ts';
import { LAYOUTS, WIDE } from '../src/layout.ts';

describe('crc32', () => {
  it('matches the standard check vector', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('is zero for empty input and unsigned for high results', () => {
    assert.equal(crc32(Buffer.alloc(0)), 0);
    assert.ok(crc32(randomBytes(64)) >= 0);
  });

  it('notices a single flipped bit', () => {
    const data = randomBytes(1024);
    const before = crc32(data);
    data[500] ^= 1;
    assert.notEqual(crc32(data), before);
  });
});

describe('container', () => {
  it('round-trips name, bytes and hash', () => {
    const data = Buffer.from('the quick brown fox'.repeat(100));
    const { stream, meta } = pack('notes.txt', data);
    const out = unpack(stream);

    assert.deepEqual(out.data, data);
    assert.equal(out.meta.name, 'notes.txt');
    assert.equal(out.meta.sha256, meta.sha256);
  });

  it('ignores the padding a group leaves behind', () => {
    const data = randomBytes(4096);
    const { stream } = pack('padded.bin', data);
    // encodeFile pads the stream out to a whole group before sharding it.
    const padded = Buffer.concat([stream, Buffer.alloc(50_000)]);

    assert.deepEqual(unpack(padded).data, data);
  });

  it('skips gzip when it would make the payload bigger', () => {
    const incompressible = randomBytes(64 * 1024);
    assert.equal(pack('random.bin', incompressible).meta.gzipped, false);
    assert.equal(pack('text.txt', Buffer.alloc(64 * 1024, 0x41)).meta.gzipped, true);
  });

  it('rejects a stream whose contents do not match its hash', () => {
    // Random input so it is stored uncompressed and the hash is what catches
    // the damage; a gzipped payload would fail in zlib first.
    const { stream } = pack('tampered.bin', randomBytes(1024));
    stream[stream.length - 1] ^= 0xff;
    assert.throws(() => unpack(stream), /sha256 mismatch/);
  });

  it('rejects foreign and truncated streams', () => {
    assert.throws(() => unpack(Buffer.alloc(64)), /bad container magic/);
    const { stream } = pack('short.bin', randomBytes(2048));
    assert.throws(() => unpack(stream.subarray(0, stream.length - 10)), /truncated stream/);
  });
});

describe('erasure coding', () => {
  const shards = () => Array.from({ length: RS_K }, () => randomBytes(WIDE.shardBytes));

  it('rebuilds the data from any RS_K of the RS_K + RS_M frames', async () => {
    const data = shards();
    const all: (Buffer | null)[] = [...data, ...(await encodeGroup(data))];

    // Lose the full parity budget, spread across data and parity frames.
    for (const lost of [0, 5, 17, 23, RS_K, RS_K + RS_M - 1]) all[lost] = null;
    assert.equal(all.filter(Boolean).length, GROUP_FRAMES - RS_M);

    assert.deepEqual(await recoverGroup(all), data);
  });

  it('is a no-op when nothing was lost', async () => {
    const data = shards();
    const all = [...data, ...(await encodeGroup(data))];
    assert.deepEqual(await recoverGroup(all), data);
  });

  it('fails loudly one frame past the budget', async () => {
    const data = shards();
    const all: (Buffer | null)[] = [...data, ...(await encodeGroup(data))];
    for (let i = 0; i <= RS_M; i++) all[i] = null;

    await assert.rejects(recoverGroup(all), /unrecoverable: 23 of 24 shards needed/);
  });
});

// Every layout is a physical layer of its own, so each one is held to the same
// bar: what one grid can round-trip, damage and repair, the other must too.
for (const layout of LAYOUTS) describe(`frame (${layout.id})`, () => {
  const payload = randomBytes(layout.shardBytes);
  const header = buildHeader({ groupIndex: 7, shardIndex: 25, flags: 0 }, payload);
  const image = renderFrame(header, payload, layout);

  it('renders a canvas of exactly one frame', () => {
    assert.equal(image.length, WIDTH * HEIGHT);
  });

  it('round-trips bits through pixels', () => {
    const decoded = decodeFrame(sampleFrame(image, WIDTH, HEIGHT, layout), layout);
    assert.ok(decoded);
    assert.deepEqual(decoded.payload, payload);
    assert.equal(decoded.header.groupIndex, 7);
    assert.equal(decoded.header.shardIndex, 25);
    assert.equal(decoded.repairedBits, 0);
  });

  it('reads the same bits back at a different resolution', () => {
    // What YouTube hands back is never the canvas that went in. The decoder
    // samples block centres, so it should not care about the scale factor.
    const scale = 2;
    const big = Buffer.alloc(WIDTH * scale * HEIGHT * scale);
    for (let y = 0; y < HEIGHT * scale; y++) {
      for (let x = 0; x < WIDTH * scale; x++) {
        big[y * WIDTH * scale + x] = image[Math.floor(y / scale) * WIDTH + Math.floor(x / scale)];
      }
    }

    const decoded = decodeFrame(sampleFrame(big, WIDTH * scale, HEIGHT * scale, layout), layout);
    assert.deepEqual(decoded?.payload, payload);
  });

  it('survives a threshold that compression has shifted', () => {
    // Black at 40 and white at 200 instead of 0 and 255: the checkerboard
    // border is what lets the decoder find the new midpoint.
    const washed = Buffer.from(image.map((v) => (v === 255 ? 200 : 40)));
    assert.deepEqual(decodeFrame(sampleFrame(washed, WIDTH, HEIGHT, layout), layout)?.payload, payload);
  });

  it('repairs the least confident bit when the CRC fails', () => {
    const sampled = sampleFrame(image, WIDTH, HEIGHT, layout);
    const target = 900;
    sampled.bits[target] ^= 1;
    sampled.confidence[target] = 0; // as a marginal block would report

    const decoded = decodeFrame(sampled, layout);
    assert.deepEqual(decoded?.payload, payload);
    assert.equal(decoded?.repairedBits, 1);
  });

  it('repairs two flipped bits', () => {
    const sampled = sampleFrame(image, WIDTH, HEIGHT, layout);
    for (const i of [64, 4096]) {
      sampled.bits[i] ^= 1;
      sampled.confidence[i] = 0;
    }
    assert.equal(decodeFrame(sampled, layout)?.repairedBits, 2);
  });

  it('reports a lost frame instead of returning wrong bytes', () => {
    // Damage far beyond the soft-decision budget: the CRC must turn this into
    // an erasure, which is the case Reed-Solomon handles. Silently returning
    // corrupt bytes here would defeat every layer above.
    const sampled = sampleFrame(image, WIDTH, HEIGHT, layout);
    for (let i = 0; i < 400; i++) sampled.bits[i * 37] ^= 1;
    assert.equal(decodeFrame(sampled, layout), null);
  });

  it('does not attempt repair when it is turned off', () => {
    const sampled = sampleFrame(image, WIDTH, HEIGHT, layout);
    sampled.bits[10] ^= 1;
    sampled.confidence[10] = 0;
    assert.equal(decodeFrame(sampled, layout, false), null);
  });

  it('rejects a frame of noise rather than parsing it', () => {
    const noise = randomBytes(WIDTH * HEIGHT);
    assert.equal(decodeFrame(sampleFrame(noise, WIDTH, HEIGHT, layout), layout), null);
  });
});

describe('layouts', () => {
  for (const layout of LAYOUTS) {
    it(`${layout.id} keeps shard bytes divisible by 8`, () => {
      // @ronomon/reed-solomon requires it; a block size or header change that
      // breaks the rule fails here rather than at the first upload.
      assert.equal(layout.shardBytes % 8, 0);
    });

    it(`${layout.id} divides the canvas into whole blocks`, () => {
      assert.equal(WIDTH % layout.block, 0);
      assert.equal(HEIGHT % layout.block, 0);
    });

    it(`${layout.id} asks for a height that is whole blocks`, () => {
      // A rendition where block edges fall between pixels is what actually
      // breaks sampling, so the floor has to divide the grid exactly.
      assert.equal(layout.minHeight % layout.gridH, 0);
      assert.ok(layout.minHeight / layout.gridH >= 2, 'needs at least two pixels a block');
    });
  }

  it('has no two layouts sharing an id', () => {
    assert.equal(new Set(LAYOUTS.map((l) => l.id)).size, LAYOUTS.length);
  });
});
