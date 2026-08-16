/**
 * One frame in, one shard out.
 *
 * Sampling a frame is the expensive half of decoding and it depends on nothing
 * but the pixels, so it runs here instead of on the thread that is also
 * draining ffmpeg. The frame arrives in a SharedArrayBuffer the pool owns —
 * the main thread copies the pipe into it and does not touch it again until
 * this worker answers, which is what makes the sharing safe without a lock.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { decodeFrame, sampleFrame } from './frame.ts';
import { layoutById } from './layout.ts';

export interface SampleRequest {
  width: number;
  height: number;
}

export interface SampleReply {
  ok: boolean;
  groupIndex: number;
  shardIndex: number;
  repairedBits: number;
  payload: Uint8Array | null;
}

const port = parentPort;
if (!port) throw new Error('sample.worker must be started as a worker thread');

const frame = new Uint8Array(workerData.frame as SharedArrayBuffer);
const layout = layoutById(workerData.layout as string);

port.on('message', ({ width, height }: SampleRequest) => {
  const decoded = decodeFrame(sampleFrame(frame, width, height, layout), layout);
  if (!decoded) {
    const miss: SampleReply = {
      ok: false,
      groupIndex: 0,
      shardIndex: 0,
      repairedBits: 0,
      payload: null,
    };
    port.postMessage(miss);
    return;
  }

  // Copied out of the shared frame's world into a buffer of its own, then
  // handed over rather than cloned: the payload is the only thing that has to
  // cross back, and it crosses without being copied twice.
  const payload = new Uint8Array(decoded.payload.length);
  payload.set(decoded.payload);

  const reply: SampleReply = {
    ok: true,
    groupIndex: decoded.header.groupIndex,
    shardIndex: decoded.header.shardIndex,
    repairedBits: decoded.repairedBits,
    payload,
  };
  port.postMessage(reply, [payload.buffer]);
});
