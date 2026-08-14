/**
 * Minimum served height the decoder can read.
 *
 * Measured in the codec lab, not guessed: a round-trip served at 900p recovers
 * byte-identical data and 810p fails outright, because below ~3.3 pixels per
 * 4-px block the frame stops being sampleable. 1080p is the nearest standard
 * rung above the cliff, so downloads pin it.
 */
export const MIN_DECODABLE_HEIGHT = 1080;

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export const REFRESH_TOKEN_KEY = 'youtube.refreshToken';

/** Quota: 10,000 units/day, videos.insert costs 1,600. */
export const UPLOAD_QUOTA_COST = 1600;
export const DAILY_QUOTA = 10_000;
