import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  quotaIsStale,
  quotaSummary,
  selectUploadAccount,
  uploadsLeft,
} from '../dist/accounts/quota.js';
import { DAILY_UPLOAD_LIMIT } from '../dist/youtube/constants.js';

interface QuotaBearing {
  label: string;
  refreshToken: unknown;
  cookieJar: unknown;
  uploadsToday: number;
  quotaResetAt: Date;
}

// 04:00 Pacific on 15 Jan 2026 — deliberately early in the Pacific day, so
// "an hour ago" is still the same day and "23 hours ago" is not.
const now = Date.UTC(2026, 0, 15, 12, 0, 0);
const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000);

function account(over: Partial<QuotaBearing> = {}): QuotaBearing {
  return {
    label: 'principal',
    refreshToken: 'sealed',
    cookieJar: 'sealed',
    uploadsToday: 0,
    quotaResetAt: hoursAgo(1),
    ...over,
  };
}

describe('quota arithmetic', () => {
  it('counts what is left of the daily allowance', () => {
    assert.equal(uploadsLeft(account({ uploadsToday: 9 }), now), DAILY_UPLOAD_LIMIT - 9);
  });

  it('forgets yesterday’s uploads', () => {
    const yesterday = account({ uploadsToday: DAILY_UPLOAD_LIMIT, quotaResetAt: hoursAgo(25) });
    assert.equal(quotaIsStale(yesterday, now), true);
    assert.equal(uploadsLeft(yesterday, now), DAILY_UPLOAD_LIMIT);
  });

  it('holds the line for the rest of the Pacific day', () => {
    const spent = account({ uploadsToday: DAILY_UPLOAD_LIMIT, quotaResetAt: hoursAgo(3) });
    assert.equal(quotaIsStale(spent, now), false);
    assert.equal(uploadsLeft(spent, now), 0);
  });

  it('clears at midnight Pacific, not 24 hours after the last upload', () => {
    // 23 hours before 04:00 PT is 05:00 PT the previous day: inside a rolling
    // 24h window, but a day Google has already zeroed. The old arithmetic
    // called this fresh spend and refused uploads that would have gone through.
    const lastNight = account({ uploadsToday: DAILY_UPLOAD_LIMIT, quotaResetAt: hoursAgo(23) });
    assert.equal(quotaIsStale(lastNight, now), true);
    assert.equal(uploadsLeft(lastNight, now), DAILY_UPLOAD_LIMIT);
  });

  // The two days of the year where "a day" and "24 hours" are different
  // lengths, and where the arithmetic this replaced was guaranteed wrong.
  it('spring forward: 23 hours apart is still a new day', () => {
    const spent = account({
      uploadsToday: DAILY_UPLOAD_LIMIT,
      quotaResetAt: new Date(Date.UTC(2026, 2, 8, 9, 0, 0)), // 01:00 PST, 8 Mar
    });
    const nextDay = Date.UTC(2026, 2, 9, 8, 0, 0); // 00:00 PDT, 9 Mar — 23h later
    assert.equal(quotaIsStale(spent, nextDay), true);
    assert.equal(uploadsLeft(spent, nextDay), DAILY_UPLOAD_LIMIT);
  });

  it('autumn back: 25 hours apart can still be the same day', () => {
    const spent = account({
      uploadsToday: DAILY_UPLOAD_LIMIT,
      quotaResetAt: new Date(Date.UTC(2026, 10, 1, 7, 10, 0)), // 00:10 PDT, 1 Nov
    });
    const sameDay = Date.UTC(2026, 10, 2, 7, 50, 0); // 23:50 PST, 1 Nov — 24h40m later
    assert.equal(sameDay - spent.quotaResetAt.getTime() > 24 * 60 * 60 * 1000, true);
    assert.equal(quotaIsStale(spent, sameDay), false);
    assert.equal(uploadsLeft(spent, sameDay), 0);
  });

  it('reports uploads, because units are not what YouTube enforces', () => {
    assert.deepEqual(quotaSummary(account(), now), {
      uploadsUsed: 0,
      uploadsLeft: DAILY_UPLOAD_LIMIT,
      dailyLimit: DAILY_UPLOAD_LIMIT,
    });
    assert.deepEqual(quotaSummary(account({ uploadsToday: DAILY_UPLOAD_LIMIT }), now), {
      uploadsUsed: DAILY_UPLOAD_LIMIT,
      uploadsLeft: 0,
      dailyLimit: DAILY_UPLOAD_LIMIT,
    });
  });
});

describe('selectUploadAccount', () => {
  it('takes the account with the most uploads left', () => {
    const roomy = account({ label: 'b', uploadsToday: 1 });
    const choice = selectUploadAccount([account({ label: 'a', uploadsToday: 40 }), roomy], now);
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
        account({ label: 'spent', uploadsToday: DAILY_UPLOAD_LIMIT }),
        usable,
      ],
      now,
    );
    assert.deepEqual(choice, { account: usable });
  });

  it('spends the last upload of the day rather than holding it back', () => {
    const last = account({ uploadsToday: DAILY_UPLOAD_LIMIT - 1 });
    assert.deepEqual(selectUploadAccount([last], now), { account: last });
    assert.deepEqual(selectUploadAccount([account({ uploadsToday: DAILY_UPLOAD_LIMIT })], now), {
      reasons: ['principal: daily upload limit reached'],
    });
  });

  it('says which of the three things to go and fix', () => {
    const choice = selectUploadAccount(
      [
        account({ label: 'a', refreshToken: null }),
        account({ label: 'b', cookieJar: null }),
        account({ label: 'c', uploadsToday: DAILY_UPLOAD_LIMIT }),
      ],
      now,
    );
    assert.deepEqual(choice, {
      reasons: ['a: not connected to Google', 'b: no cookie jar', 'c: daily upload limit reached'],
    });
  });

  it('handles having nothing to choose from', () => {
    assert.deepEqual(selectUploadAccount([], now), { reasons: [] });
  });
});
