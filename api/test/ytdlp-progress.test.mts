import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentIn } from '../dist/youtube/ytdlp.service.js';

/** What --progress-template writes, one line per update thanks to --newline. */
function line(done: string, total: string): string {
  return `yts-progress ${done} ${total}`;
}

describe('percentIn', () => {
  it('reads a percentage out of the two byte counts', () => {
    assert.equal(percentIn(line('50', '200')), 25);
    assert.equal(percentIn(line('200', '200')), 100);
  });

  it('reports null while the total is not known', () => {
    // yt-dlp prints NA until the download starts, and for some fragmented
    // streams it never learns the size at all.
    assert.equal(percentIn(line('1024', 'NA')), null);
    assert.equal(percentIn(line('NA', 'NA')), null);
    assert.equal(percentIn(line('1024', '0')), null);
  });

  it('ignores every other line yt-dlp prints', () => {
    // undefined, not null: a line about a player client must not blank a bar
    // that is already moving.
    assert.equal(percentIn('[youtube] abc: Downloading webpage'), undefined);
    assert.equal(percentIn('[download] Destination: /data/restore/x/download.mp4'), undefined);
    assert.equal(percentIn(''), undefined);
  });
});
