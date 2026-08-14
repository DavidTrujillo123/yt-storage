import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { encodeFile } from '../src/encode.ts';
import { decodeVideo } from '../src/decode.ts';
import { simulateYouTube } from '../src/ffmpeg.ts';
import { GROUP_BYTES } from '../src/geometry.ts';

/**
 * The claim this project rests on, exercised end to end: a file survives a VP9
 * re-encode and comes back byte-identical, and stops surviving below the
 * measured resolution floor.
 *
 * Slow — VP9 at 4K is not fast — and needs ffmpeg, so it is skipped rather than
 * failed where ffmpeg is absent.
 */
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const FIVE_MINUTES = 300_000;

describe('round trip through a simulated YouTube', { skip: hasFfmpeg ? false : 'ffmpeg not installed' }, () => {
  let dir: string;
  let source: string;
  let master: string;
  let sha256: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'isg-test-'));
    source = join(dir, 'payload.bin');
    master = join(dir, 'master.mp4');

    // One group exactly: 24 data frames plus 6 parity, the smallest input that
    // exercises the erasure coding. Random, so gzip cannot shrink it and the
    // frames carry real entropy.
    const data = randomBytes(GROUP_BYTES - 4096);
    sha256 = createHash('sha256').update(data).digest('hex');
    await writeFile(source, data);

    const encoded = await encodeFile(source, master);
    assert.equal(encoded.groups, 1);
    assert.equal(encoded.frames, 30);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recovers the file byte-for-byte at 1080p and crf 50', { timeout: FIVE_MINUTES }, async () => {
    const served = join(dir, 'served-1080.webm');
    await simulateYouTube(master, served, { crf: 50, height: 1080 });

    const out = await mkdtemp(join(dir, 'out-1080-'));
    const result = await decodeVideo(served, out);

    assert.equal(result.sha256, sha256);
    assert.equal(result.framesRead, 30);
    // Inside the parity budget is the requirement; zero losses is not.
    assert.ok(result.framesLost <= 6, `lost ${result.framesLost} frames, budget is 6`);
  });

  it('fails below the resolution floor instead of returning wrong bytes', { timeout: FIVE_MINUTES }, async () => {
    // 810p is the measured cliff: under ~3.3 pixels per 4-px block the frame
    // stops being sampleable. The point of the test is that it fails loudly —
    // a silent drop to a lower rendition would produce an unrecoverable file,
    // which is why every yt-dlp call pins a minimum height with no fallback.
    const served = join(dir, 'served-810.webm');
    await simulateYouTube(master, served, { crf: 36, height: 810 });

    const out = await mkdtemp(join(dir, 'out-810-'));
    await assert.rejects(decodeVideo(served, out), /no readable frames found|missing entire groups/);
  });
});
