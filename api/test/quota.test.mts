import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  quotaIsStale,
  quotaSummary,
  remainingQuota,
  selectUploadAccount,
} from '../dist/accounts/quota.js';
import { DAILY_QUOTA, UPLOAD_QUOTA_COST } from '../dist/youtube/constants.js';

interface QuotaBearing {
  label: string;
  refreshToken: unknown;
  cookieJar: unknown;
  quotaUsed: number;
  quotaResetAt: Date;
}

const now = Date.UTC(2026, 0, 15, 12, 0, 0);
const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000);

function account(over: Partial<QuotaBearing> = {}): QuotaBearing {
  return {
    label: 'principal',
    refreshToken: 'sealed',
    cookieJar: 'sealed',
    quotaUsed: 0,
    quotaResetAt: hoursAgo(1),
    ...over,
  };
}

describe('quota arithmetic', () => {
  it('counts what is left of the daily budget', () => {
    assert.equal(remainingQuota(account({ quotaUsed: 3200 }), now), DAILY_QUOTA - 3200);
  });

  it('forgets yesterday’s spend', () => {
    const yesterday = account({ quotaUsed: DAILY_QUOTA, quotaResetAt: hoursAgo(25) });
    assert.equal(quotaIsStale(yesterday, now), true);
    assert.equal(remainingQuota(yesterday, now), DAILY_QUOTA);
  });

  it('holds the line inside the 24 hour window', () => {
    const spent = account({ quotaUsed: DAILY_QUOTA, quotaResetAt: hoursAgo(23) });
    assert.equal(quotaIsStale(spent, now), false);
    assert.equal(remainingQuota(spent, now), 0);
  });

  it('reports uploads left, not units, because units mean nothing to anyone', () => {
    assert.deepEqual(quotaSummary(account(), now), {
      used: 0,
      remaining: DAILY_QUOTA,
      uploadsLeft: Math.floor(DAILY_QUOTA / UPLOAD_QUOTA_COST),
    });
    assert.equal(quotaSummary(account({ quotaUsed: DAILY_QUOTA - 1599 }), now).uploadsLeft, 0);
  });
});

describe('selectUploadAccount', () => {
  it('takes the account with the most quota left', () => {
    const roomy = account({ label: 'b', quotaUsed: 1600 });
    const choice = selectUploadAccount([account({ label: 'a', quotaUsed: 6400 }), roomy], now);
    assert.deepEqual(choice, { account: roomy });
  });

  it('skips accounts that cannot finish the job', () => {
    // Chosen at upload time rather than at ingest precisely because any of
    // these can change while a file sits in the queue.
    const usable = account({ label: 'usable' });
    const choice = selectUploadAccount(
      [
        account({ label: 'not connected', refreshToken: null }),
        account({ label: 'no cookies', cookieJar: null }),
        account({ label: 'spent', quotaUsed: DAILY_QUOTA }),
        usable,
      ],
      now,
    );
    assert.deepEqual(choice, { account: usable });
  });

  it('will not start an upload it cannot pay for', () => {
    // videos.insert costs 1,600 units and is charged whether or not it
    // succeeds, so an account one unit short must not be picked.
    const choice = selectUploadAccount([account({ quotaUsed: DAILY_QUOTA - UPLOAD_QUOTA_COST + 1 })], now);
    assert.deepEqual(choice, { reasons: ['principal: daily quota spent'] });
  });

  it('says which of the three things to go and fix', () => {
    const choice = selectUploadAccount(
      [
        account({ label: 'a', refreshToken: null }),
        account({ label: 'b', cookieJar: null }),
        account({ label: 'c', quotaUsed: DAILY_QUOTA }),
      ],
      now,
    );
    assert.deepEqual(choice, {
      reasons: ['a: not connected to Google', 'b: no cookie jar', 'c: daily quota spent'],
    });
  });

  it('handles having nothing to choose from', () => {
    assert.deepEqual(selectUploadAccount([], now), { reasons: [] });
  });
});
