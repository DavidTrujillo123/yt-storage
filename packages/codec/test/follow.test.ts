import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { encodeFile } from '../src/encode.ts';
import { decodeVideo } from '../src/decode.ts';
import { DENSE } from '../src/layout.ts';

/**
 * Decoding a video that is still being written.
 *
 * A restore used to download the whole video and only then start reading it —
 * measured at 370 seconds of download followed by 201 of decode, in series, for
 * one 689 MB file. The decoder was already streaming, so the only thing keeping
 * the two apart was ffmpeg stopping at whatever end-of-file it happened to
 * find. `follow` makes it wait for a sentinel instead.
 *
 * What has to hold is not that it is faster — that is measured against the live
 * instance — but that it is *identical*. A decode that overlaps a download and
 * returns different bytes would be worse than a slow one in every way.
 */
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const TWO_MINUTES = 120_000;

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'follow-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes `video` to `path` in pieces, then drops the sentinel — a download, slowly. */
async function dribble(video: Buffer, path: string, done: string, pieces = 10): Promise<void> {
  const size = Math.ceil(video.length / pieces);
  await writeFile(path, video.subarray(0, size));
  for (let at = size; at < video.length; at += size) {
    await new Promise((wake) => setTimeout(wake, 150));
    await appendFile(path, video.subarray(at, at + size));
  }
  await writeFile(done, '');
}

describe('decoding a download that is still arriving', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  it('recovers the same bytes as a decode of the finished file', { timeout: TWO_MINUTES }, async () => {
    const original = randomBytes(300_000);
    const source = join(dir, 'original.bin');
    await writeFile(source, original);

    const video = join(dir, 'video.mp4');
    await encodeFile(source, video);
    const bytes = await readFile(video);

    // The control: the same video, complete, decoded the ordinary way.
    const whole = join(dir, 'whole');
    await mkdir(whole, { recursive: true });
    const settled = await decodeVideo(video, whole, undefined, DENSE);

    // The subject: the same video arriving in pieces while it is read.
    const growing = join(dir, 'growing.mp4');
    const done = join(dir, 'growing.done');
    const followed = join(dir, 'followed');
    await mkdir(followed, { recursive: true });
    const [, result] = await Promise.all([
      dribble(bytes, growing, done),
      decodeVideo(growing, followed, undefined, DENSE, done),
    ]);

    assert.equal(result.sha256, settled.sha256, 'followed decode disagrees with the settled one');
    assert.deepEqual(await readFile(result.name), original, 'followed decode lost bytes');
    assert.equal(result.framesLost, 0);
  });

  it('detects the grid without a hint, which needs frames that have not arrived yet', {
    timeout: TWO_MINUTES,
  }, async () => {
    // The case that actually broke first. Detection reads a handful of frames
    // before the real read begins, and against a file a twelfth written it
    // reported "no readable frames found" and failed a restore of a perfectly
    // good video. Most stored rows have no layout recorded, so this is the
    // normal path rather than an edge of it.
    const original = randomBytes(300_000);
    const source = join(dir, 'hintless.bin');
    await writeFile(source, original);

    const video = join(dir, 'hintless.mp4');
    await encodeFile(source, video);
    const bytes = await readFile(video);

    const growing = join(dir, 'hintless-growing.mp4');
    const done = join(dir, 'hintless.done');
    const out = join(dir, 'hintless-out');
    await mkdir(out, { recursive: true });
    const [, result] = await Promise.all([
      dribble(bytes, growing, done, 12),
      decodeVideo(growing, out, undefined, undefined, done),
    ]);

    assert.equal(result.layout, DENSE.id);
    assert.deepEqual(await readFile(result.name), original);
  });
});
