import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { encodeFile } from './encode.ts';
import { decodeRange, decodeVideo } from './decode.ts';
import { simulateYouTube } from './ffmpeg.ts';
import { readHeader } from './container.ts';
import { FPS, GROUP_FRAMES, RS_K, RS_M } from './geometry.ts';
import { LAYOUTS, encodingLayout, layoutById, type Layout } from './layout.ts';

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

/**
 * Pulls `--name value` out of the argv and hands back what is left.
 *
 * Only the flags this CLI has, and only in that form: the positional arguments
 * are what everything here is really driven by, and an options parser would be
 * more machinery than the three flags justify.
 */
function takeOption(args: string[], name: string): { value: string | null; rest: string[] } {
  const at = args.indexOf(name);
  if (at === -1) return { value: null, rest: args };
  const value = args[at + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return { value, rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const [command, ...args] = argv.filter((a) => a !== '--json');

  if (command === 'specs') {
    // With --json this is the API's only source for the geometry: it runs the
    // codec out of process, so it cannot import these numbers, and a second
    // copy of `groupBytes` on the other side of that boundary is a copy that
    // will eventually disagree.
    if (json) {
      console.log(
        JSON.stringify({
          fps: FPS,
          groupFrames: GROUP_FRAMES,
          writing: encodingLayout().id,
          layouts: LAYOUTS.map((layout) => ({
            id: layout.id,
            block: layout.block,
            shardBytes: layout.shardBytes,
            groupBytes: layout.groupBytes,
            minHeight: layout.minHeight,
          })),
        }),
      );
      return;
    }
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
    // The grid, when the caller already knows it. It saves the detection pass,
    // which is a second ffmpeg reading frames at native resolution before the
    // real read starts; a wrong id would fail on the first frame's magic, so
    // this is a shortcut and never a claim the decoder has to trust.
    const { value: layoutArg, rest: afterLayout } = takeOption(args, '--layout');
    // Decode a video that is still arriving, stopping when this file appears.
    // A sentinel rather than a signal because the writer is another process
    // entirely — the app downloads, this decodes — and a file showing up is the
    // smallest thing that crosses that line.
    const { value: follow, rest } = takeOption(afterLayout, '--follow');
    const hint: Layout | undefined = layoutArg ? layoutById(layoutArg) : undefined;
    const [video, outDir = '.'] = rest;
    if (!video) {
      throw new Error('usage: decode <video> [output-dir] [--layout <id>] [--follow <sentinel>]');
    }

    await mkdir(outDir, { recursive: true });
    const stats = await decodeVideo(video, outDir, (n, total) => {
      if (n % 30 !== 0) return;
      progress(
        json,
        { type: 'progress', frames: n, total },
        total ? `reading frame ${n}/${total}` : `reading frame ${n}`,
      );
    }, hint, follow);

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

  if (command === 'decode-range') {
    const { value: layoutArg, rest: afterLayout } = takeOption(args, '--layout');
    const hint: Layout | undefined = layoutArg ? layoutById(layoutArg) : undefined;
    // For a video that is already only the section holding the range: its
    // timeline starts at the cut, so there is nothing to seek past.
    const seek = !afterLayout.includes('--from-start');
    const rest = afterLayout.filter((arg) => arg !== '--from-start');
    const [video, startArg, endArg, outPath] = rest;
    if (!video || !startArg || !endArg || !outPath) {
      throw new Error(
        'usage: decode-range <video> <start-group> <end-group> <output-file> ' +
          '[--layout <id>] [--from-start]',
      );
    }

    // Raw stream bytes, not a file: the caller knows which slice of the
    // container it asked for and what to do with it. Writing them out is this
    // command's whole job, because the API talks to the codec over a pipe and
    // a hundred megabytes does not belong in stdout.
    const { bytes, stats } = await decodeRange(video, Number(startArg), Number(endArg), hint, seek);
    await writeFile(outPath, bytes);

    if (json) {
      console.log(JSON.stringify({ ...stats, name: outPath, bytes: bytes.length }));
      return;
    }
    console.log(`layout       ${stats.layout}`);
    console.log(`groups       ${startArg}..${endArg}  (${stats.groupsRecovered} recovered)`);
    console.log(`frames read  ${stats.framesRead}`);
    console.log(`repaired     ${stats.framesRepaired}  (soft-decision bit flips)`);
    console.log(`lost         ${stats.framesLost}  (rebuilt from parity)`);
    console.log(`written      ${outPath}  ${mib(bytes.length)}`);
    return;
  }

  if (command === 'header') {
    const [streamPath] = args;
    if (!streamPath) throw new Error('usage: header <stream-file>');

    // The first bytes of a decoded range, read as a container header. It exists
    // so the API can find where the payload starts and whether it is gzipped
    // without a second copy of the format on the other side of the process
    // boundary — a partial read cannot start from the middle of a gzip stream,
    // so that flag decides whether a partial read is possible at all.
    const head = await readFile(streamPath);
    const meta = readHeader(head);

    if (json) {
      console.log(JSON.stringify(meta));
      return;
    }
    console.log(`name         ${meta.name}`);
    console.log(`payload      ${mib(meta.payloadLength)} at offset ${meta.payloadOffset}`);
    console.log(`gzipped      ${meta.gzipped}`);
    console.log(`sha256       ${meta.sha256}`);
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

  console.log('usage: isg <encode|decode|decode-range|header|roundtrip|specs> [...]');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
