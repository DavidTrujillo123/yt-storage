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

/**
 * What YouTube actually enforces on uploads, which is not what the docs say.
 *
 * The documented model is 10,000 quota units a day with `videos.insert` at
 * 1,600 of them, capping a project at six uploads. Measured against a live
 * project on 14 Aug 2026, that is not what happens: nine uploads in one day
 * all succeeded, the Cloud Console's `Queries per day` counter stayed at 0
 * throughout, and `Video Uploads per day` tracked every one of them. The
 * counter that moves is the one that binds.
 *
 * So the budget modelled here is the upload count. The unit budget is left
 * out entirely rather than tracked alongside — this app makes no other Data
 * API call, so there is nothing else that could spend units.
 */
export const DAILY_UPLOAD_LIMIT = 100;
