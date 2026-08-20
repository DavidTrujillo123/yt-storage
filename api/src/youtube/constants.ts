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
  // Renaming a stored file rewrites the title and description of every video
  // behind it, and `videos.update` is a write that uploading does not cover.
  // An account connected before this scope was asked for keeps working for
  // everything else; only the rename on YouTube's side refuses, and says so.
  'https://www.googleapis.com/auth/youtube.force-ssl',
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
 * So the budget modelled here is the upload count. The unit budget is left out
 * entirely rather than tracked alongside: the only other Data API calls this
 * app makes are the ones that rebuild the catalogue from a channel —
 * `channels.list` and `playlistItems.list`, 1 unit each — so a full import of a
 * two-thousand-video channel spends about 41 of the day's 10,000. Next to a
 * single `videos.insert`, documented at 1,600, that is noise; if a listing
 * feature ever runs in a loop, this is the comment that stops being true.
 */
export const DAILY_UPLOAD_LIMIT = 100;

/**
 * The longest video the channel will accept, in seconds.
 *
 * A channel that has not verified a phone number is capped at fifteen minutes,
 * and what happens past it is worth spelling out because it does not look like
 * a refusal: `videos.insert` succeeds, the video appears, YouTube starts
 * processing it and then stops with "Procesamiento interrumpido - el vídeo es
 * demasiado largo". Measured on `71BoJ-0cBk0`, a 23:10 upload of 2 GiB: the
 * insert returned an id, the app waited on a transcode that was never coming,
 * and yt-dlp eventually answered "This video was removed because it was too
 * long".
 *
 * That is almost certainly what happened to `oJW7GciZsAQ` too — 1242 groups is
 * 20:42 of video, past the cap — and it is why that file sits in the list as
 * `ready` with only the first ten minutes of itself on YouTube.
 *
 * Duration is set by the payload alone: a group is one second of video, so the
 * cap is really a size limit of `groupBytes` per second. Verifying the channel
 * raises it to twelve hours, which is why this is an env var and not a
 * constant to live with.
 */
export const UNVERIFIED_MAX_VIDEO_SECONDS = 15 * 60;

/** What a channel accepts once a phone number is verified: twelve hours. */
export const VERIFIED_MAX_VIDEO_SECONDS = 12 * 60 * 60;

/** The scope renaming and deleting need, which uploading does not carry. */
export const MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
