import { DAILY_UPLOAD_LIMIT } from '../youtube/constants';

/**
 * Quota arithmetic and upload-account selection, kept free of Nest and TypeORM.
 *
 * This is the logic that decides whether a file can be uploaded at all, and it
 * is pure: rows in, decision out. Living outside the service means it can be
 * tested without a database or a DI container.
 *
 * The budget is counted in uploads, not quota units — see `DAILY_UPLOAD_LIMIT`
 * for the measurement that settled which of the two YouTube actually enforces.
 */
export interface QuotaBearing {
  label: string;
  refreshToken: unknown;
  cookieJar: unknown;
  uploadsToday: number;
  quotaResetAt: Date;
}

/**
 * `en-CA` renders `YYYY-MM-DD`, so two instants fall on the same Pacific day
 * exactly when their formatted strings are equal — and the formatter absorbs
 * the DST shifts that make a naive 24h subtraction wrong twice a year.
 */
const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Google resets the daily allowance at midnight Pacific, so that — not a
 * rolling 24h window from the last upload — is the boundary.
 *
 * The rolling window this replaced drifted: `quotaResetAt` only moved when an
 * upload landed on an already-stale row, so it stayed anchored to whenever
 * uploading last resumed after an idle gap. Uploads from late yesterday
 * Pacific were zeroed by Google at 00:00 but still counted locally for another
 * day, which refused uploads that Google would have accepted.
 */
export function quotaIsStale(account: QuotaBearing, now = Date.now()): boolean {
  return PACIFIC_DAY.format(account.quotaResetAt) !== PACIFIC_DAY.format(new Date(now));
}

/** Uploads this account can still make before midnight Pacific. */
export function uploadsLeft(account: QuotaBearing, now = Date.now()): number {
  return DAILY_UPLOAD_LIMIT - (quotaIsStale(account, now) ? 0 : account.uploadsToday);
}

export function quotaSummary(
  account: QuotaBearing,
  now = Date.now(),
): { uploadsUsed: number; uploadsLeft: number; dailyLimit: number } {
  const left = uploadsLeft(account, now);
  return {
    uploadsUsed: DAILY_UPLOAD_LIMIT - left,
    uploadsLeft: left,
    dailyLimit: DAILY_UPLOAD_LIMIT,
  };
}

/**
 * Picks the account that can actually complete an upload: connected, holding
 * cookies, and with uploads left — the one with the most left first.
 *
 * Returns the reasons instead of an account when none qualifies, because "no
 * account can upload" on its own tells the owner nothing about which of the
 * three things to go and fix.
 */
export function selectUploadAccount<T extends QuotaBearing>(
  candidates: T[],
  now = Date.now(),
): { account: T } | { reasons: string[] } {
  const usable = candidates
    .map((account) => ({ account, left: uploadsLeft(account, now) }))
    .filter(({ account, left }) => account.refreshToken && account.cookieJar && left >= 1)
    .sort((a, b) => b.left - a.left);

  if (usable.length > 0) return { account: usable[0].account };

  return {
    reasons: candidates.map((account) => {
      if (!account.refreshToken) return `${account.label}: not connected to Google`;
      if (!account.cookieJar) return `${account.label}: no cookie jar`;
      return `${account.label}: daily upload limit reached`;
    }),
  };
}
