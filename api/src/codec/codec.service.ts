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
}

export interface DecodeResult {
  framesRead: number;
  framesLost: number;
  framesRepaired: number;
  groupsRecovered: number;
  name: string;
  bytes: number;
  sha256: string;
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
    onProgress?: (percent: number) => void,
  ): Promise<DecodeResult> {
    this.log.log(`decoding ${videoPath}`);
    // Frames read out of the frames the video holds. The total is absent when
    // the container does not carry one, and then there is no percentage to
    // report — the caller shows the phase without a bar rather than a made-up
    // number.
    return this.run<DecodeResult>(['decode', videoPath, outputDir], (event) => {
      if (event.type === 'progress' && typeof event.frames === 'number' && typeof event.total === 'number') {
        onProgress?.(Math.round((event.frames / event.total) * 100));
      }
    });
  }
}
