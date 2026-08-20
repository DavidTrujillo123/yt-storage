import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shortUploadMessage } from '../dist/files/restore.service.js';

/**
 * The check that would have caught `oJW7GciZsAQ`: a file listed as ready whose
 * video holds 607 of the 1242 groups its own header asks for. Sampling never
 * saw it — every group it picks is inside whatever length the video has — so
 * the only thing that finds it is comparing the two numbers.
 */
describe('refusing an upload that never finished', () => {
  const fps = 30;
  const groupFrames = 30;

  it('names both counts when the video is short', () => {
    const message = shortUploadMessage({ seconds: 608, fps, groupFrames, totalGroups: 1242 });
    assert.match(message ?? '', /incomplete upload/);
    // 608 rather than the 607.6 the frames come to: yt-dlp reports whole
    // seconds, which is exactly why the check carries a group of slack.
    assert.match(message ?? '', /608 of the 1242 groups/);
  });

  it('passes a video that is exactly long enough', () => {
    assert.equal(shortUploadMessage({ seconds: 68, fps, groupFrames, totalGroups: 68 }), null);
  });

  it('passes a video YouTube padded past the end', () => {
    // A rendition routinely comes back a little longer than it went up, and
    // that is what the decoder's own tail handling is for.
    assert.equal(shortUploadMessage({ seconds: 69, fps, groupFrames, totalGroups: 68 }), null);
  });

  it('allows a whole group of slack, because the duration is whole seconds', () => {
    // 67s of video for 68 groups is rounding, not loss. 66s is loss.
    assert.equal(shortUploadMessage({ seconds: 67, fps, groupFrames, totalGroups: 68 }), null);
    assert.match(
      shortUploadMessage({ seconds: 66, fps, groupFrames, totalGroups: 68 }) ?? '',
      /incomplete upload/,
    );
  });

  it('never refuses a single-group file, the shortest video there is', () => {
    assert.equal(shortUploadMessage({ seconds: 1, fps, groupFrames, totalGroups: 1 }), null);
  });
});
