import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BEST_HEIGHT, heightForRow, heightFromRow, spreadGroups } from '../dist/files/restore.service.js';
import { looksRateLimited } from '../dist/youtube/ytdlp.service.js';

describe('the stored restore height', () => {
  it('tells "nothing recorded" apart from "the best rendition"', () => {
    // The bug this replaces: both were null, the candidate order tested for
    // truthiness, and a file that only decodes at 2160p re-downloaded a 1080p
    // rendition it could never read on every single restore.
    assert.equal(heightFromRow(null), undefined, 'nothing recorded');
    assert.equal(heightFromRow(BEST_HEIGHT), null, 'the best rendition');
    assert.equal(heightFromRow(1080), 1080, 'that rung exactly');
  });

  it('round-trips every answer a restore can arrive at', () => {
    for (const height of [1080, 1440, 2160, null]) {
      assert.equal(heightFromRow(heightForRow(height)), height);
    }
  });

  it('never writes a value that could be mistaken for a served height', () => {
    // Zero is the sentinel precisely because no rendition is zero pixels tall.
    assert.equal(heightForRow(null), 0);
    assert.notEqual(heightForRow(1080), 0);
  });
});

describe('spreadGroups', () => {
  it('always includes the ends, where truncation and a bad header show up', () => {
    const picked = spreadGroups(1000, 8);
    assert.equal(picked[0], 0);
    assert.equal(picked[picked.length - 1], 999);
  });

  it('spreads the rest rather than clustering them', () => {
    const picked = spreadGroups(1000, 8);
    assert.equal(picked.length, 8);
    const gaps = picked.slice(1).map((group, index) => group - picked[index]);
    // Even spacing, allowing for rounding to whole groups.
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `uneven gaps: ${gaps.join(',')}`);
  });

  it('returns every group when there are fewer than the sample size', () => {
    assert.deepEqual(spreadGroups(3, 8), [0, 1, 2]);
    assert.deepEqual(spreadGroups(1, 8), [0]);
  });

  it('never repeats a group, so no section is fetched twice', () => {
    for (const total of [9, 10, 11, 16, 17]) {
      const picked = spreadGroups(total, 8);
      assert.equal(new Set(picked).size, picked.length, `duplicate in ${picked.join(',')}`);
    }
  });
});

describe('looksRateLimited', () => {
  it('recognises YouTube asking for a slower rate', () => {
    assert.ok(looksRateLimited('ERROR: unable to download: HTTP Error 429: Too Many Requests'));
    assert.ok(looksRateLimited("Sign in to confirm you're not a bot"));
  });

  it('does not read an ordinary failure as back-pressure', () => {
    assert.equal(looksRateLimited('ERROR: [youtube] abc: Private video.'), false);
    assert.equal(looksRateLimited('Requested format is not available'), false);
  });
});
