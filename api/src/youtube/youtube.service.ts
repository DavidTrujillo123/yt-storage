import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, statSync } from 'node:fs';
import { google, youtube_v3 } from 'googleapis';
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
    return google.youtube({ version: 'v3', auth });
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
    meta: { fileId: string; name: string; sha256: string },
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const youtube = this.client(account);
    const total = statSync(videoPath).size;

    const response = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: `yt-storage ${meta.fileId}`,
            description: [
              'yt-storage container. Not video content.',
              `file: ${meta.name}`,
              `sha256: ${meta.sha256}`,
            ].join('\n'),
          },
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

    await this.accounts.chargeQuota(account.id);
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
}
