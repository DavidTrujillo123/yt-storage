import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, statSync } from 'node:fs';
// The single-API package rather than `googleapis`, which carries a client for
// every Google service there is and was 207 MB of the container on its own.
// This app calls two endpoints on one of them.
import { youtube as youtubeApi, youtube_v3 } from '@googleapis/youtube';
import { AccountsService } from '../accounts/accounts.service';
import type { YtAccount } from '../accounts/yt-account.entity';

@Injectable()
export class YoutubeService {
  private readonly log = new Logger(YoutubeService.name);

  constructor(private readonly accounts: AccountsService) {}

  private client(account: YtAccount): youtube_v3.Youtube {
    const refreshToken = this.accounts.refreshTokenOf(account);
    if (!refreshToken) throw new Error(`account ${account.label} is not connected to Google`);

    const auth = this.accounts.oauthClient(account);
    auth.setCredentials({ refresh_token: refreshToken });
    return youtubeApi({ version: 'v3', auth });
  }

  /**
   * Uploads as `private`. Not a limitation worth fighting: videos from an
   * unaudited API project are locked private regardless, and this app is the
   * only consumer.
   *
   * The description carries the filename and hash so the catalogue can be
   * rebuilt from YouTube alone if the local database is ever lost — otherwise
   * losing one small SQLite file would leave a channel of unidentifiable
   * videos.
   */
  async upload(
    account: YtAccount,
    videoPath: string,
    meta: { fileId: string; name: string; sha256: string; part?: PartOf },
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const youtube = this.client(account);
    const total = statSync(videoPath).size;

    // Counted before the call, not after: this is a simple upload rather than
    // a resumable one, so a connection dropped at 90% is a full retry, and an
    // insert YouTube accepted and then lost still spent the day's allowance.
    // Counting on success only would drift below the real figure exactly when
    // the day was going badly.
    await this.accounts.recordUpload(account.id);

    const response = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: {
          snippet: { title: containerTitle(meta), description: containerDescription(meta) },
          status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
        },
        media: { body: createReadStream(videoPath) },
      },
      {
        onUploadProgress: (event: { bytesRead: number }) =>
          onProgress?.(Math.min(99, Math.round((event.bytesRead / total) * 100))),
      },
    );

    const videoId = response.data.id;
    if (!videoId) throw new Error('upload succeeded but YouTube returned no video id');

    this.log.log(`uploaded ${videoId} via ${account.label}`);
    return videoId;
  }

  /** `processed` only means YouTube finished *something* — not that a 1080p rendition exists. */
  async processingStatus(account: YtAccount, videoId: string): Promise<string | null> {
    const { data } = await this.client(account).videos.list({
      part: ['processingDetails'],
      id: [videoId],
    });
    return data.items?.[0]?.processingDetails?.processingStatus ?? null;
  }

  async delete(account: YtAccount, videoId: string): Promise<void> {
    await this.client(account).videos.delete({ id: videoId });
  }

  /**
   * Rewrites a stored video's title and description after a rename.
   *
   * Both, not just the title: the description is what a rebuild reads, so a
   * rename that only touched the title would come back under the old name the
   * first time the catalogue is rebuilt from the channel.
   *
   * `videos.update` needs a write scope that uploading does not, so an account
   * connected before that scope existed will refuse this — which is a reason to
   * tell the operator to reconnect, never a reason to fail the rename. The name
   * that matters is the one in this database; the channel is a mirror of it.
   */
  async retitle(
    account: YtAccount,
    videoId: string,
    meta: { fileId: string; name: string; sha256: string; part?: PartOf },
  ): Promise<void> {
    const youtube = this.client(account);

    // The category has to be sent back or the update is rejected, and YouTube
    // will not infer it: an update to `snippet` replaces the whole of it.
    const { data } = await youtube.videos.list({ part: ['snippet'], id: [videoId] });
    const categoryId = data.items?.[0]?.snippet?.categoryId ?? '22';

    await youtube.videos.update({
      part: ['snippet'],
      requestBody: {
        id: videoId,
        snippet: {
          title: containerTitle(meta),
          description: containerDescription(meta),
          categoryId,
        },
      },
    });
    this.log.log(`retitled ${videoId} to "${containerTitle(meta)}"`);
  }

  /**
   * Every video on the channel, newest first — the read side of what `upload`
   * writes, and the only way a lost catalogue can be found again.
   *
   * Two calls: the channel names its own uploads playlist, and that playlist
   * lists everything. `search.list` would do it in one, at 100 quota units
   * against these two's 1 apiece, and it silently omits recent uploads.
   *
   * `youtube.readonly` is already granted at sign-in, so nothing here asks
   * anyone to authorise again.
   */
  async listUploads(
    account: YtAccount,
    playlistId: string | null,
    maxPages = MAX_IMPORT_PAGES,
  ): Promise<{ videos: ChannelVideo[]; playlistId: string; truncated: boolean }> {
    const youtube = this.client(account);
    const uploads = playlistId ?? (await this.uploadsPlaylist(youtube, account));

    const videos: ChannelVideo[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      const { data } = await youtube.playlistItems.list({
        part: ['snippet'],
        playlistId: uploads,
        maxResults: 50,
        pageToken,
      });

      for (const item of data.items ?? []) {
        const videoId = item.snippet?.resourceId?.videoId;
        if (!videoId) continue;
        // A playlist keeps its entry after the video behind it is gone, as a
        // stub titled "Deleted video". Measured on this channel: 7 of 16
        // entries were those. Reporting them as videos left alone would bury
        // the ones that matter under rows nobody can act on.
        if (GONE.has(item.snippet?.title ?? '')) continue;
        videos.push({
          videoId,
          title: item.snippet?.title ?? '',
          description: item.snippet?.description ?? '',
          publishedAt: item.snippet?.publishedAt ?? null,
        });
      }

      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken && ++pages < maxPages);

    // A channel longer than the walk is a real answer, not a failure: the rest
    // is one more import away, and saying so beats pretending the list is whole.
    return { videos, playlistId: uploads, truncated: Boolean(pageToken) };
  }

  private async uploadsPlaylist(youtube: youtube_v3.Youtube, account: YtAccount): Promise<string> {
    const { data } = await youtube.channels.list({ part: ['contentDetails'], mine: true });
    const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) {
      throw new Error(
        `${account.label} authorised no channel, so there is nothing to list - ` +
          'connect it to the Google account that owns the channel',
      );
    }
    return uploads;
  }
}

/** How far an import walks before it stops and says so: 50 videos a page. */
export const MAX_IMPORT_PAGES = 40;

/**
 * The titles YouTube substitutes for a video the caller cannot see. They come
 * back in English whatever the caller's locale, and there is no field that says
 * "this entry is a stub" — the title is the only tell.
 */
const GONE = new Set(['Deleted video', 'Private video']);

export interface ChannelVideo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string | null;
}

/**
 * The title a container video wears on the channel.
 *
 * The file's own name, because that is the only thing that makes a channel of
 * these readable to the person who owns it — and, for a file split across
 * videos, the part number, so the run reads `Cursos Virtuales p1`,
 * `Cursos Virtuales p2` in the order it has to be joined.
 *
 * The title is decoration and nothing depends on it: identity lives in the
 * description, where `parseContainerVideo` reads it. That split is what lets a
 * file be renamed — the title follows the new name, and a rebuild still finds
 * the same row. Videos uploaded before this change carry the id in the title
 * instead, and the parser still accepts those.
 */
export function containerTitle(meta: { fileId: string; name?: string; part?: PartOf }): string {
  if (!meta.name) return `yt-storage ${meta.fileId}`;
  return meta.part ? `${meta.name} p${meta.part.index + 1}` : meta.name;
}

/** Which piece of a split file a video holds, 0-based. */
export interface PartOf {
  index: number;
  count: number;
}

/**
 * What the catalogue is rebuilt from, so it is written in one place and read in
 * one place, both of them here.
 */
export function containerDescription(meta: {
  fileId: string;
  name: string;
  sha256: string;
  part?: PartOf;
}): string {
  return [
    'yt-storage container. Not video content.',
    // The id moved here from the title when titles became the file's name: a
    // renamed file rewrites its titles, and identity cannot live in something
    // that changes.
    `id: ${meta.fileId}`,
    `file: ${meta.name}`,
    `sha256: ${meta.sha256}`,
    // Only on a split file, and it says everything a rebuild needs to put the
    // pieces back in order without a database.
    ...(meta.part ? [`part: ${meta.part.index + 1} of ${meta.part.count}`] : []),
  ].join('\n');
}

/** What a container video's description says about the file inside it. */
export interface ContainerVideo {
  fileId: string;
  name: string;
  sha256: string;
  /** Present only when the video holds one piece of a split file. */
  part?: PartOf;
}

/**
 * The file behind a video, or null when that video is not one of ours.
 *
 * The inverse of what `upload` writes, and deliberately in the same file: the
 * two shapes have to move together, and a parser living anywhere else would be
 * free to drift until the day someone needs it and finds it broken.
 *
 * Strict on purpose. A video whose title or description does not match exactly
 * is reported as unrecognised rather than guessed at — a wrong hash stored as
 * if it were right turns into a download that refuses its own bytes.
 */
export function parseContainerVideo(video: ChannelVideo): ContainerVideo | null {
  // The id from the description first, and only then from the title. Both are
  // written by this app: the description form is what a video carries now, the
  // title form is what every video uploaded before titles became filenames
  // carries, and dropping the second would orphan a whole channel of them.
  const fromDescription = video.description.match(/^id:\s*([0-9a-f-]{36})\s*$/im);
  const fromTitle = video.title.match(/^yt-storage\s+([0-9a-f-]{36})$/i);
  const fileId = fromDescription?.[1] ?? fromTitle?.[1];
  if (!fileId) return null;

  const name = video.description.match(/^file:\s*(.+)$/m);
  const sha256 = video.description.match(/^sha256:\s*([0-9a-f]{64})\s*$/im);
  if (!name || !sha256) return null;

  const part = video.description.match(/^part:\s*(\d+)\s+of\s+(\d+)\s*$/im);

  return {
    fileId,
    name: name[1].trim(),
    sha256: sha256[1].toLowerCase(),
    ...(part ? { part: { index: Number(part[1]) - 1, count: Number(part[2]) } } : {}),
  };
}
