/**
 * A pool of threads that sample frames.
 *
 * Decoding is two costs: ffmpeg turning a video back into pixels, which is
 * already spread over every core, and reading blocks back out of those pixels,
 * which was one thread doing three quarters of the work. This hands each frame
 * to a worker and lets the main thread go back to draining the pipe.
 *
 * Each worker owns exactly one frame-sized SharedArrayBuffer. A worker is only
 * ever handed a frame while it is idle, so nobody writes a buffer another
 * thread is reading, and no frame is copied to hand it over.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Layout } from './layout.ts';
import type { SampleReply } from './sample.worker.ts';

export interface SampledShard {
  ok: boolean;
  groupIndex: number;
  shardIndex: number;
  repairedBits: number;
  payload: Buffer | null;
}

/**
 * How many threads sample.
 *
 * Two cores are left for ffmpeg and for the thread feeding the pipe, and the
 * ceiling is there because past a handful of workers the video is being
 * decoded no faster and the frames simply queue.
 *
 * The four was measured when every frame arrived at 2160p. Frames now arrive
 * downscaled to what the grid needs, which made sampling cheaper rather than
 * dearer — so ffmpeg is if anything more of the bottleneck than it was, and
 * the number is left alone rather than raised on a guess. `CODEC_WORKERS`
 * overrides it for anyone who wants to measure their own machine.
 */
export function workerCount(): number {
  const asked = Number(process.env.CODEC_WORKERS);
  if (Number.isFinite(asked) && asked >= 0) return Math.floor(asked);
  // Two cores left for ffmpeg and the main thread, and no ceiling beyond that.
  //
  // The cap used to be four, from a time when the download was the whole wall
  // clock and CPU was free to leave idle. It is not any more: with an external
  // downloader a ten-gigabyte video lands in under two minutes and the decode
  // is the rest of the restore — measured at 11m23s for 2 GiB while the
  // container sat at 241% of twelve available cores. Four workers was leaving
  // three quarters of the machine unused on the phase that now dominates.
  return Math.max(1, availableParallelism() - 2);
}

/** Where the worker file lives, whether this is running from source or from dist. */
function workerEntry(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './sample.worker.ts' : './sample.worker.js', here);
}

export class SamplePool {
  private readonly idle: number[] = [];
  private readonly waiting: { resolve: (worker: number) => void; reject: (error: Error) => void }[] = [];
  private readonly onReply: (((shard: SampledShard) => void) | null)[];
  private inFlight = 0;
  private drained: (() => void) | null = null;
  private failure: Error | null = null;

  private readonly workers: Worker[];
  private readonly frames: Uint8Array[];

  // Written out rather than declared as constructor parameters: Node runs this
  // package straight from source, and its type stripping refuses parameter
  // properties — they are the one TypeScript feature that emits code.
  private constructor(workers: Worker[], frames: Uint8Array[]) {
    this.workers = workers;
    this.frames = frames;
    this.onReply = workers.map(() => null);
    workers.forEach((worker, index) => {
      this.idle.push(index);
      worker.on('message', (reply: SampleReply) => this.settle(index, reply));
      worker.on('error', (error: Error) => this.fail(error));
    });
  }

  /** Starts `count` workers, each with its own frame buffer of `frameSize` bytes. */
  static async open(frameSize: number, count: number, layout: Layout): Promise<SamplePool> {
    const entry = workerEntry();
    const workers: Worker[] = [];
    const frames: Uint8Array[] = [];

    try {
      for (let i = 0; i < count; i++) {
        const shared = new SharedArrayBuffer(frameSize);
        const worker = new Worker(entry, { workerData: { frame: shared, layout: layout.id } });
        // A worker that cannot start says so here rather than on the first
        // frame, so the caller can fall back before any frame is read.
        await new Promise<void>((resolve, reject) => {
          worker.once('online', resolve);
          worker.once('error', reject);
        });
        workers.push(worker);
        frames.push(new Uint8Array(shared));
      }
    } catch (error) {
      await Promise.all(workers.map((worker) => worker.terminate()));
      throw error;
    }

    return new SamplePool(workers, frames);
  }

  /** The buffer to fill for a worker this call has already been given. */
  frame(worker: number): Uint8Array {
    return this.frames[worker];
  }

  /** Resolves with a worker index once one is free. */
  acquire(): Promise<number> {
    if (this.failure) return Promise.reject(this.failure);
    const free = this.idle.pop();
    if (free !== undefined) return Promise.resolve(free);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  /** Hands the filled frame to its worker. The reply arrives on `onDone`. */
  submit(worker: number, width: number, height: number, onDone: (shard: SampledShard) => void): void {
    this.onReply[worker] = onDone;
    this.inFlight++;
    this.workers[worker].postMessage({ width, height });
  }

  /** Waits for every submitted frame to have been answered. */
  async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => {
      this.drained = resolve;
    });
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private settle(worker: number, reply: SampleReply): void {
    const done = this.onReply[worker];
    this.onReply[worker] = null;
    this.inFlight--;

    const next = this.waiting.shift();
    if (next) next.resolve(worker);
    else this.idle.push(worker);

    done?.({
      ok: reply.ok,
      groupIndex: reply.groupIndex,
      shardIndex: reply.shardIndex,
      repairedBits: reply.repairedBits,
      payload: reply.payload ? Buffer.from(reply.payload.buffer, reply.payload.byteOffset, reply.payload.length) : null,
    });

    if (this.inFlight === 0 && this.drained) {
      const resolve = this.drained;
      this.drained = null;
      resolve();
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    // Whoever is waiting for a worker, or for the last frame, would otherwise
    // wait forever on a pool that has stopped answering.
    while (this.waiting.length) this.waiting.shift()!.reject(error);
    if (this.drained) {
      const resolve = this.drained;
      this.drained = null;
      resolve();
    }
  }
}
