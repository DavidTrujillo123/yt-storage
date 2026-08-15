import { Injectable } from '@nestjs/common';

export type RestorePhase = 'idle' | 'downloading' | 'decoding';

export interface RestoreState {
  phase: RestorePhase;
  /** 0-100, or null while the total is not known yet. */
  percent: number | null;
  startedAt: string | null;
}

/**
 * How far along a restore is, for the browser to ask about.
 *
 * Reading a stored file means downloading the whole video and decoding it —
 * minutes for anything large, because the codec carries roughly 383 KB of file
 * per second of video. That work happens inside one request, so without this
 * the page has nothing to show but a spinner, and a spinner cannot distinguish
 * "downloading a 400 MB video" from "hung".
 *
 * In memory on purpose: it describes a request that is running in this process
 * right now, and a restart cannot leave a stale one behind. Nothing here is
 * worth a row, and both processes never restore the same file at once — the
 * worker verifies, the API serves.
 */
@Injectable()
export class RestoreProgress {
  private readonly running = new Map<string, RestoreState>();

  begin(fileId: string): void {
    this.running.set(fileId, {
      phase: 'downloading',
      percent: null,
      startedAt: new Date().toISOString(),
    });
  }

  set(fileId: string, phase: RestorePhase, percent: number | null): void {
    const current = this.running.get(fileId);
    if (!current) return;
    // Clamped rather than trusted: yt-dlp's total is an estimate until the
    // last fragment, and an estimate that turns out low reads as 103%.
    this.running.set(fileId, {
      ...current,
      phase,
      percent: percent === null ? null : Math.max(0, Math.min(100, Math.round(percent))),
    });
  }

  end(fileId: string): void {
    this.running.delete(fileId);
  }

  get(fileId: string): RestoreState {
    return this.running.get(fileId) ?? { phase: 'idle', percent: null, startedAt: null };
  }
}
