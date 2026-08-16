import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFile } from './encode.ts';
import { decodeVideo } from './decode.ts';
import { simulateYouTube } from './ffmpeg.ts';
import { FPS, GROUP_FRAMES, RS_K, RS_M } from './geometry.ts';
import { LAYOUTS, encodingLayout, layoutById } from './layout.ts';

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

function specs(): void {
  const writing = encodingLayout();
  console.log(`group        ${RS_K} data + ${RS_M} parity = ${GROUP_FRAMES} frames`);
  console.log(`             tolerates ${RS_M} dead frames per group`);
  for (const layout of LAYOUTS) {
    const perSecond = (layout.groupBytes / GROUP_FRAMES) * FPS;
    const mark = layout.id === writing.id ? ' <- writing' : '';
    console.log('');
    console.log(`${layout.id}${mark}`);
    console.log(`  block      ${layout.block}px, grid ${layout.gridW}x${layout.gridH}`);
    console.log(`  shard      ${layout.shardBytes} bytes/frame, ${mib(layout.groupBytes)} per group`);
    console.log(`  throughput ${mib(perSecond)}/s of video at ${FPS} fps`);
    console.log(`             ${mib(perSecond * 3600)} per hour of video`);
    console.log(`  needs      a rendition served at ${layout.minHeight}p or better`);
  }
}

/**
 * With --json, progress goes to stderr as one JSON object per line and the
 * result to stdout as a single object. That is the contract the API's child
 * process wrapper parses; the human-readable output is for the terminal.
 */
function progress(json: boolean, event: Record<string, unknown>, human: string): void {
  process.stderr.write(json ? `${JSON.stringify(event)}\n` : `\r${human}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const [command, ...args] = argv.filter((a) => a !== '--json');

  if (command === 'specs') {
    specs();
    return;
  }

  if (command === 'encode') {
    const [input, output, layoutArg] = args;
    if (!input || !output) throw new Error('usage: encode <input-file> <output.mp4> [layout]');
    const layout = layoutArg ? layoutById(layoutArg) : encodingLayout();

    const result = await encodeFile(
      input,
      output,
      (done, total) => {
        progress(json, { type: 'progress', done, total }, `encoding group ${done}/${total}`);
      },
      layout,
    );
    const video = await stat(output);

    if (json) {
      console.log(JSON.stringify({ ...result, videoBytes: video.size }));
      return;
    }
    process.stderr.write('\n');
    console.log(`layout       ${result.layout} (needs ${layout.minHeight}p served back)`);
    console.log(`frames       ${result.frames}`);
    console.log(`duration     ${(result.frames / FPS).toFixed(1)}s`);
    console.log(`payload      ${mib(result.originalBytes)}`);
    console.log(`video        ${mib(video.size)}  (${(video.size / result.originalBytes).toFixed(1)}x bloat)`);
    return;
  }

  if (command === 'decode') {
    const [video, outDir = '.'] = args;
    if (!video) throw new Error('usage: decode <video> [output-dir]');

    await mkdir(outDir, { recursive: true });
    const stats = await decodeVideo(video, outDir, (n, total) => {
      if (n % 30 !== 0) return;
      progress(
        json,
        { type: 'progress', frames: n, total },
        total ? `reading frame ${n}/${total}` : `reading frame ${n}`,
      );
    });

    if (json) {
      console.log(JSON.stringify(stats));
      return;
    }
    process.stderr.write('\n');
    console.log(`layout       ${stats.layout}`);
    console.log(`frames read  ${stats.framesRead}`);
    console.log(`repaired     ${stats.framesRepaired}  (soft-decision bit flips)`);
    console.log(`lost         ${stats.framesLost}  (rebuilt from parity)`);
    console.log(`written      ${stats.name}  ${mib(stats.bytes)}`);
    console.log(`sha256       ${stats.sha256}`);
    return;
  }

  if (command === 'roundtrip') {
    const [input, crfArg, heightArg] = args;
    if (!input) throw new Error('usage: roundtrip <input-file> [crf] [served-height]');
    const crf = crfArg ? Number(crfArg) : 32;
    const height = heightArg ? Number(heightArg) : undefined;

    const work = await mkdtemp(join(tmpdir(), 'isg-'));
    const clean = join(work, 'clean.mp4');
    const compressed = join(work, 'youtube.webm');

    console.log('1/3 encoding');
    const result = await encodeFile(input, clean);

    const at = height ? ` served at ${height}p` : '';
    console.log(`2/3 simulating YouTube re-encode (VP9 crf ${crf}${at})`);
    await simulateYouTube(clean, compressed, { crf, height });

    console.log('3/3 decoding');
    const stats = await decodeVideo(compressed, work);

    const original = await readFile(input);
    const recovered = await readFile(stats.name);
    const same =
      createHash('sha256').update(original).digest('hex') ===
      createHash('sha256').update(recovered).digest('hex');

    const cleanSize = (await stat(clean)).size;
    const compressedSize = (await stat(compressed)).size;

    console.log('');
    console.log(`frames       ${result.frames}`);
    console.log(`upload size  ${mib(cleanSize)} for ${mib(result.originalBytes)} of data`);
    console.log(`after VP9    ${mib(compressedSize)}`);
    console.log(`repaired     ${stats.framesRepaired} frames`);
    console.log(`lost         ${stats.framesLost} frames (budget: ${RS_M} per ${GROUP_FRAMES})`);
    console.log('');
    console.log(same ? 'PASS - byte-identical' : 'FAIL - files differ');
    if (!same) process.exitCode = 1;
    return;
  }

  console.log('usage: isg <encode|decode|roundtrip|specs> [...]');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
