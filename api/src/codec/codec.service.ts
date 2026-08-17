import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface EncodeResult {
  groups: number;
  frames: number;
  streamBytes: number;
  originalBytes: number;
  videoBytes: number;
  /** Which grid wrote it. The decoder detects this itself; the log says it. */
  layout: string;
}

export interface DecodeResult {
  framesRead: number;
  framesLost: number;
  framesRepaired: number;
  groupsRecovered: number;
  name: string;
  bytes: number;
  sha256: string;
  layout: string;
}

export interface LayoutSpec {
  id: string;
  block: number;
  shardBytes: number;
  /** Payload bytes per Reed-Solomon group — the unit a partial read works in. */
  groupBytes: number;
  minHeight: number;
}

export interface CodecSpecs {
  fps: number;
  groupFrames: number;
  writing: string;
  layouts: LayoutSpec[];
}

export interface ContainerHeader {
  name: string;
  payloadLength: number;
  sha256: string;
  gzipped: boolean;
  payloadOffset: number;
}

export interface RangeResult {
  framesRead: number;
  framesLost: number;
  framesRepaired: number;
  groupsRecovered: number;
  startGroup: number;
  layout: string;
  /** Path the raw stream bytes were written to. */
  name: string;
  bytes: number;
}

/**
 * Runs the codec CLI as a child process.
 *
 * Encoding is a tight pixel loop that would pin the event loop for minutes, so
 * it does not belong in the HTTP process under any circumstances. Running it
 * out-of-process also keeps the ESM codec and this CommonJS Nest app from
 * having to agree on a module system.
 */
@Injectable()
export class CodecService {
  private readonly log = new Logger(CodecService.name);
  private readonly cli: string;

  constructor(config: ConfigService) {
    this.cli = resolve(config.get<string>('CODEC_CLI', '../packages/codec/src/cli.ts'));
  }

  private run<T>(args: string[], onProgress?: (event: Record<string, unknown>) => void): Promise<T> {
    return new Promise((resolvePromise, reject) => {
      const proc = spawn('node', [this.cli, ...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderrTail = '';
      proc.stdout.on('data', (chunk) => (stdout += chunk));

      // Progress arrives on stderr as one JSON object per line.
      let buffer = '';
      proc.stderr.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          stderrTail = line;
          try {
            onProgress?.(JSON.parse(line));
          } catch {
            // Non-JSON lines are ffmpeg noise; keep the last one for errors.
          }
        }
      });

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`codec ${args[0]} failed: ${(buffer || stderrTail).trim()}`));
        }
        try {
          resolvePromise(JSON.parse(stdout) as T);
        } catch {
          reject(new Error(`codec ${args[0]} produced unparseable output`));
        }
      });
    });
  }

  /**
   * The codec's geometry, asked once and kept.
   *
   * A partial read has to turn a byte offset into a group index and a group
   * index into a second of video, which needs `groupBytes` and the frame rate.
   * Both live in the codec package, which this app cannot import — it is ESM
   * and this is CommonJS, which is half of why the codec runs out of process
   * at all — so they are asked for rather than copied.
   */
  async specs(): Promise<CodecSpecs> {
    this.cachedSpecs ??= this.run<CodecSpecs>(['specs']);
    return this.cachedSpecs;
  }

  private cachedSpecs: Promise<CodecSpecs> | null = null;

  /** The geometry of one grid, or the one every pre-layout video used. */
  async layout(id: string | null | undefined): Promise<LayoutSpec> {
    const { layouts } = await this.specs();
    const found = layouts.find((layout) => layout.id === id);
    if (found) return found;
    // The same fallback the codec makes: nothing before layouts existed says
    // which grid it is, and all of it is the wide one.
    const wide = layouts.find((layout) => layout.id === 'wide');
    if (!wide) throw new Error('the codec reports no wide layout');
    return wide;
  }

  async encode(
    inputPath: string,
    outputPath: string,
    onProgress?: (percent: number) => void,
  ): Promise<EncodeResult> {
    this.log.log(`encoding ${inputPath}`);
    return this.run<EncodeResult>(['encode', inputPath, outputPath], (event) => {
      if (event.type === 'progress' && typeof event.done === 'number' && typeof event.total === 'number') {
        onProgress?.(Math.round((event.done / event.total) * 100));
      }
    });
  }

  async decode(
    videoPath: string,
    outputDir: string,
    onProgress?: (percent: number | null, framesRead: number) => void,
    layout?: string | null,
  ): Promise<DecodeResult> {
    this.log.log(`decoding ${videoPath}`);
    // Frames read out of the frames the video holds. The total is absent when
    // the container does not carry one, and then there is no percentage to
    // report — the caller shows the phase without a bar rather than a made-up
    // number.
    //
    // `null` is reported rather than nothing at all, and that distinction is
    // the whole fix. This used to stay silent whenever the total was missing,
    // and the caller only learns a decode has started by being told — so a
    // download that had just finished sat on screen at 100% for the entire
    // decode, which is what "it gets stuck at 100%" was. A remuxed yt-dlp
    // download is exactly the case where `nb_frames` is N/A, so this was not
    // the rare path, it was the normal one.
    return this.run<DecodeResult>(
      ['decode', videoPath, outputDir, ...(layout ? ['--layout', layout] : [])],
      (event) => {
        if (event.type !== 'progress' || typeof event.frames !== 'number') return;
        // The frame count goes out alongside the percentage so a caller that
        // knows the denominator some other way — a restore knows the file's
        // size, and the grid says how many frames that is — can work one out
        // when the container refuses to.
        onProgress?.(
          typeof event.total === 'number' && event.total > 0
            ? Math.round((event.frames / event.total) * 100)
            : null,
          event.frames,
        );
      },
    );
  }

  /**
   * Decodes a run of groups into raw container-stream bytes.
   *
   * No progress: a range is seconds of video, and a bar that finishes before
   * the page has drawn it is worse than none.
   */
  async decodeRange(
    videoPath: string,
    startGroup: number,
    endGroup: number,
    outPath: string,
    layout?: string | null,
    fromStart = false,
  ): Promise<RangeResult> {
    this.log.log(`decoding groups ${startGroup}..${endGroup} of ${videoPath}`);
    return this.run<RangeResult>([
      'decode-range',
      videoPath,
      String(startGroup),
      String(endGroup),
      outPath,
      ...(layout ? ['--layout', layout] : []),
      // A video fetched as a section has its own timeline starting at the cut,
      // so there is nothing before the range to seek past.
      ...(fromStart ? ['--from-start'] : []),
    ]);
  }

  /** Reads the container header out of a file of decoded stream bytes. */
  async header(streamPath: string): Promise<ContainerHeader> {
    return this.run<ContainerHeader>(['header', streamPath]);
  }
}
