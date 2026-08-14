import { DAILY_QUOTA, UPLOAD_QUOTA_COST } from '../youtube/constants';

/**
 * Quota arithmetic and upload-account selection, kept free of Nest and TypeORM.
 *
 * This is the logic that decides whether a file can be uploaded at all, and it
 * is pure: rows in, decision out. Living outside the service means it can be
 * tested without a database or a DI container.
 */
export interface QuotaBearing {
  label: string;
  refreshToken: unknown;
  cookieJar: unknown;
  quotaUsed: number;
  quotaResetAt: Date;
}

/** Google resets quota at midnight Pacific; a rolling 24h window is close enough. */
export function quotaIsStale(account: QuotaBearing, now = Date.now()): boolean {
  return now - account.quotaResetAt.getTime() > 24 * 60 * 60 * 1000;
}

export function remainingQuota(account: QuotaBearing, now = Date.now()): number {
  return DAILY_QUOTA - (quotaIsStale(account, now) ? 0 : account.quotaUsed);
}

export function quotaSummary(
  account: QuotaBearing,
  now = Date.now(),
): { used: number; remaining: number; uploadsLeft: number } {
  const remaining = remainingQuota(account, now);
  return {
    used: DAILY_QUOTA - remaining,
    remaining,
    uploadsLeft: Math.floor(remaining / UPLOAD_QUOTA_COST),
  };
}

/**
 * Picks the account that can actually complete an upload: connected, holding
 * cookies, and with quota left — the one with the most quota first.
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
    .map((account) => ({ account, quota: remainingQuota(account, now) }))
    .filter(({ account, quota }) => account.refreshToken && account.cookieJar && quota >= UPLOAD_QUOTA_COST)
    .sort((a, b) => b.quota - a.quota);

  if (usable.length > 0) return { account: usable[0].account };

  return {
    reasons: candidates.map((account) => {
      if (!account.refreshToken) return `${account.label}: not connected to Google`;
      if (!account.cookieJar) return `${account.label}: no cookie jar`;
      return `${account.label}: daily quota spent`;
    }),
  };
}
