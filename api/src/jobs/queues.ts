export const ENCODE_QUEUE = 'encode';
export const UPLOAD_QUEUE = 'upload';
export const VERIFY_QUEUE = 'verify';

export interface FileJob {
  fileId: string;
}

/**
 * YouTube takes minutes to hours to produce a 1080p rendition, so verification
 * polls rather than waits.
 *
 * Not exponential: BullMQ's exponential backoff has no ceiling, so after a
 * handful of perfectly normal "still transcoding" retries the next check lands
 * half an hour out and the file looks dead. Not a flat three minutes either —
 * forty of those covered two hours, and a 4K upload can take longer than that
 * to get its high renditions, so files were being failed for being slow.
 *
 * Two rates instead: three minutes while the answer might arrive any moment,
 * then a quarter of an hour out to a day. That also keeps the polling rate low
 * over the long tail, which is the shape that would attract attention.
 */
export const VERIFY_BACKOFF_MS = 180_000;
const SLOW_BACKOFF_MS = 900_000;
const FAST_ATTEMPTS = 20; // 20 x 3 min = the first hour
export const VERIFY_ATTEMPTS = FAST_ATTEMPTS + 92; // + 92 x 15 min = 24 hours

/**
 * Registered as the `custom` backoff strategy on the verify worker; jobs ask
 * for it with `backoff: { type: 'custom' }`.
 */
export function verifyBackoff(attemptsMade: number): number {
  return attemptsMade < FAST_ATTEMPTS ? VERIFY_BACKOFF_MS : SLOW_BACKOFF_MS;
}

/** The options every verify job is queued with, from both the upload step and reconcile. */
export const verifyJobOptions = (fileId: string) => ({
  jobId: fileId,
  delay: VERIFY_BACKOFF_MS,
  attempts: VERIFY_ATTEMPTS,
  backoff: { type: 'custom' as const },
});
