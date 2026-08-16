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

/** How hard YouTube is simulated per layout, and the height that must fail. */
const cases: { layout: Layout; crf: number; below: number }[] = [
  { layout: WIDE, crf: 50, below: 810 },
  // Denser blocks get a harsher crf than the crf 32 YouTube is estimated at,
  // rather than the extreme the wide grid shrugs off. 972p is where it stops:
  // one rung down from the height it needs, and measured.
  { layout: DENSE, crf: 36, below: 972 },
];

for (const { layout, crf, below } of cases) {
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
