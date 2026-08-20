import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tooLongForYoutube } from '../dist/jobs/upload.processor.js';

/**
 * The cap that cost a 2 GiB upload: past it `videos.insert` succeeds, the
 * transcode is abandoned, and the file ends up with a video id pointing at
 * something YouTube deletes. Checking the frame count first is the whole fix.
 */
describe('refusing a video the channel will not accept', () => {
  const cap = 15 * 60;

  it('passes anything inside the cap', () => {
    assert.equal(tooLongForYoutube(30), null, 'one group');
    assert.equal(tooLongForYoutube(cap * 30), null, 'exactly the cap');
  });

  it('measures against the channel that is taking the file', () => {
    // 23:10 is over the unverified cap and nowhere near the verified one, and
    // the same encode is fine or refused depending only on which account has
    // quota when its turn comes.
    assert.match(tooLongForYoutube(41700, false) ?? '', /too long/);
    assert.equal(tooLongForYoutube(41700, true), null);
    // Twelve hours is the verified cap; a minute past it is refused again.
    assert.match(tooLongForYoutube((12 * 3600 + 60) * 30, true) ?? '', /too long/);
  });

  it('refuses the 2 GiB encode that YouTube threw away', () => {
    // 41,700 frames is what `big-2gb.bin` came to: 23:10 against a 15:00 cap.
    const message = tooLongForYoutube(41700);
    assert.match(message ?? '', /too long for this channel/);
    assert.match(message ?? '', /23:10/);
    assert.match(message ?? '', /15:00/);
  });

  it('names the way out that applies to this channel', () => {
    // Unverified: verifying is the fix, and the switch is where it is claimed.
    const unverified = tooLongForYoutube(41700, false) ?? '';
    assert.match(unverified, /Verify the channel/);
    assert.match(unverified, /switch/);

    // Verified and still too long: verifying is no longer advice worth giving.
    const verified = tooLongForYoutube((13 * 3600) * 30, true) ?? '';
    assert.match(verified, /Split the file/);
    assert.doesNotMatch(verified, /Verify the channel/);
  });

  it('says nothing when the frame count is unknown', () => {
    // An imported row has no frame count, and refusing on missing data would
    // fail files that are perfectly fine.
    assert.equal(tooLongForYoutube(null), null);
    assert.equal(tooLongForYoutube(0), null);
  });
});
