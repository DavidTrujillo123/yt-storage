import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { encodeFile } from '../src/encode.ts';
import { decodeRange, decodeVideo } from '../src/decode.ts';
import { simulateYouTube } from '../src/ffmpeg.ts';
import { pack } from '../src/container.ts';
import { DENSE, WIDE, type Layout } from '../src/layout.ts';

/**
 * The claim this project rests on, exercised end to end: a file survives a VP9
 * re-encode and comes back byte-identical, and stops surviving below the
 * measured resolution floor of the grid that wrote it.
 *
 * Both layouts run the same two tests, and the `wide` ones are what keep
 * every video uploaded before layouts existed readable.
 *
 * Slow — VP9 at 4K is not fast — and needs ffmpeg, so it is skipped rather than
 * failed where ffmpeg is absent.
 */
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const FIVE_MINUTES = 300_000;

/**
 * How hard YouTube is simulated per layout, the height that must fail, and a
 * quality nobody expects to see.
 *
 * `harsh` is there to watch the margin rather than only the result. The master
 * is written with x264's `ultrafast` preset, which is three times faster than
 * the `veryfast` it replaced and costs a little fidelity: measured on 840
 * frames, a crf 44 transcode of the dense grid needs the soft-decision repair
 * on two of them where the old master needed none. Two is fine — the erasure
 * budget is six frames in every thirty and nothing was lost — but it is the
 * number that would move first if the preset were pushed further, so it is
 * asserted rather than remembered.
 */
const cases: { layout: Layout; crf: number; below: number; harsh: number }[] = [
  { layout: WIDE, crf: 50, below: 810, harsh: 58 },
  // Denser blocks get a harsher crf than the crf 32 YouTube is estimated at,
  // rather than the extreme the wide grid shrugs off. 972p is where it stops:
  // one rung down from the height it needs, and measured.
  { layout: DENSE, crf: 36, below: 972, harsh: 44 },
];

for (const { layout, crf, below, harsh } of cases) {
  describe(
    `round trip through a simulated YouTube (${layout.id})`,
    { skip: hasFfmpeg ? false : 'ffmpeg not installed' },
    () => {
      let dir: string;
      let master: string;
      let sha256: string;

      before(async () => {
        dir = await mkdtemp(join(tmpdir(), `isg-test-${layout.id}-`));
        const source = join(dir, 'payload.bin');
        master = join(dir, 'master.mp4');

        // One group exactly: 24 data frames plus 6 parity, the smallest input
        // that exercises the erasure coding. Random, so gzip cannot shrink it
        // and the frames carry real entropy.
        const data = randomBytes(layout.groupBytes - 4096);
        sha256 = createHash('sha256').update(data).digest('hex');
        await writeFile(source, data);

        const encoded = await encodeFile(source, master, undefined, layout);
        assert.equal(encoded.groups, 1);
        assert.equal(encoded.frames, 30);
        assert.equal(encoded.layout, layout.id);
      });

      after(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      it(
        `recovers the file byte-for-byte at ${layout.minHeight}p and crf ${crf}`,
        { timeout: FIVE_MINUTES },
        async () => {
          const served = join(dir, 'served.webm');
          await simulateYouTube(master, served, { crf, height: layout.minHeight });

          const out = await mkdtemp(join(dir, 'out-'));
          const result = await decodeVideo(served, out);

          assert.equal(result.sha256, sha256);
          assert.equal(result.framesRead, 30);
          // Nobody told the decoder which grid this was: it worked it out.
          assert.equal(result.layout, layout.id);
          // Inside the parity budget is the requirement; zero losses is not.
          assert.ok(result.framesLost <= 6, `lost ${result.framesLost} frames, budget is 6`);
        },
      );

      it(
        `still recovers it at crf ${harsh}, well past anything YouTube applies`,
        { timeout: FIVE_MINUTES },
        async () => {
          const served = join(dir, 'served-harsh.webm');
          await simulateYouTube(master, served, { crf: harsh, height: layout.minHeight });

          const out = await mkdtemp(join(dir, 'out-harsh-'));
          const result = await decodeVideo(served, out);

          assert.equal(result.sha256, sha256);
          assert.equal(result.framesLost, 0, `lost ${result.framesLost} frames at crf ${harsh}`);
          // The margin, watched. A master written by a faster preset spends a
          // little of this; spending much of it is the signal to look at why.
          assert.ok(
            result.framesRepaired <= 6,
            `repaired ${result.framesRepaired} of 30 frames at crf ${harsh}`,
          );
        },
      );

      it(
        'recovers the file byte-for-byte from a 2160p rendition, downscaled on the way in',
        { timeout: FIVE_MINUTES },
        async () => {
          // The rendition YouTube actually serves for these uploads is the 4K
          // one, and the decoder shrinks it to the detail the grid needs before
          // sampling — two pixels a block for `dense`, four for `wide`. This is
          // the path that carries every real restore, and the only one where
          // ffmpeg's scaler sits between the transcode and the sampler.
          const served = join(dir, 'served-2160.webm');
          await simulateYouTube(master, served, { crf });

          const out = await mkdtemp(join(dir, 'out-2160-'));
          const result = await decodeVideo(served, out);

          assert.equal(result.sha256, sha256);
          assert.equal(result.framesRead, 30);
          assert.equal(result.layout, layout.id);
          assert.ok(result.framesLost <= 6, `lost ${result.framesLost} frames, budget is 6`);
        },
      );

      it(
        'recovers the file when the rendition carries frames past the payload',
        { timeout: FIVE_MINUTES },
        async () => {
          // What a real rendition does and the simulation did not: YouTube
          // hands back a video a few frames longer than the one that went up.
          // Those frames hold no shards, and a decoder that works out the last
          // group from the frame count rather than from the frames themselves
          // asks for a group that was never encoded — which failed every
          // restore that had no local copy to answer from with "missing entire
          // groups: <one past the last>".
          const served = join(dir, 'served-padded.webm');
          await simulateYouTube(master, served, { crf, height: layout.minHeight, padFrames: 4 });

          const out = await mkdtemp(join(dir, 'out-padded-'));
          const result = await decodeVideo(served, out);

          assert.equal(result.sha256, sha256);
          assert.ok(result.framesRead > 30, `read ${result.framesRead} frames, expected the pad`);
        },
      );

      it(
        `fails below ${layout.minHeight}p instead of returning wrong bytes`,
        { timeout: FIVE_MINUTES },
        async () => {
          // Below its floor a frame stops being sampleable: block edges no
          // longer land on pixel edges and every block reads its neighbour.
          // The point of the test is that it fails loudly — a silent drop to a
          // lower rendition would produce an unrecoverable file, which is why
          // every yt-dlp call pins a minimum height with no fallback.
          const served = join(dir, 'served-low.webm');
          await simulateYouTube(master, served, { crf: 36, height: below });

          const out = await mkdtemp(join(dir, 'out-low-'));
          await assert.rejects(
            decodeVideo(served, out),
            /no readable frames found|missing entire groups/,
          );
        },
      );
    },
  );
}

/**
 * Reading part of a file without pulling all of it back.
 *
 * This is what a preview of one entry in a bundle rests on: a byte range of
 * the archive is a run of groups, a group is a second of video, and the frames
 * say which group they belong to so the seek never has to be exact.
 */
describe(
  'decoding a range of groups',
  { skip: hasFfmpeg ? false : 'ffmpeg not installed' },
  () => {
    const layout = DENSE;
    const GROUPS = 3;

    let dir: string;
    let served: string;
    let stream: Buffer;

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), 'isg-test-range-'));
      const source = join(dir, 'payload.bin');
      const master = join(dir, 'master.mp4');
      served = join(dir, 'served.webm');

      // Three whole groups minus the header, so the stream needs no padding
      // and every group in it is one the test can name exactly.
      const { stream: probeStream } = pack('payload.bin', Buffer.alloc(0));
      const data = randomBytes(GROUPS * layout.groupBytes - probeStream.length);
      await writeFile(source, data);
      stream = pack('payload.bin', data).stream;
      assert.equal(stream.length, GROUPS * layout.groupBytes);

      await encodeFile(source, master, undefined, layout);
      await simulateYouTube(master, served, { crf: 36, height: layout.minHeight });
    });

    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('returns the middle group and nothing else', { timeout: FIVE_MINUTES }, async () => {
      const { bytes, stats } = await decodeRange(served, 1, 1, layout);

      assert.equal(bytes.length, layout.groupBytes);
      assert.deepEqual(bytes, stream.subarray(layout.groupBytes, 2 * layout.groupBytes));
      assert.equal(stats.groupsRecovered, 1);
      assert.equal(stats.startGroup, 1);
      // The point of the exercise: it stops rather than reading to the end.
      assert.ok(
        stats.framesRead < GROUPS * 30,
        `read ${stats.framesRead} frames of ${GROUPS * 30} for one group`,
      );
    });

    it('returns the whole stream when asked for every group', { timeout: FIVE_MINUTES }, async () => {
      const { bytes } = await decodeRange(served, 0, GROUPS - 1, layout);
      assert.deepEqual(bytes, stream);
    });

    it('refuses a range the video does not have', { timeout: FIVE_MINUTES }, async () => {
      await assert.rejects(decodeRange(served, GROUPS + 4, GROUPS + 4, layout), /is not in/);
    });

    it('reads a range out of a video cut down to it', { timeout: FIVE_MINUTES }, async () => {
      // What `yt-dlp --download-sections` hands back: a video whose timeline
      // starts at the cut rather than at the start of the original. Seeking to
      // "group 1" inside it would land a second past everything wanted, so the
      // read starts from the beginning and lets the frames say where they are.
      const cut = join(dir, 'cut.webm');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-loglevel', 'error', '-y',
          '-ss', '1', '-to', '3',
          '-i', served,
          '-c', 'copy',
          cut,
        ]);
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
      });

      const { bytes } = await decodeRange(cut, 1, 1, layout, false);
      assert.deepEqual(bytes, stream.subarray(layout.groupBytes, 2 * layout.groupBytes));
    });
  },
);
