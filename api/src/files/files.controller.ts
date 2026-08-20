import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { statSync } from 'node:fs';
import { dispositionOf, serveRange } from './serve';
import { isTarName } from './tar';
import { MAX_BUNDLE_ENTRIES } from './bundle';
import type { Request, Response } from 'express';
import { FilesService } from './files.service';
import type { StoredFile } from './stored-file.entity';
import { RestoreProgress } from './restore-progress';
import { RestoreService, type RestoredBytes } from './restore.service';
import { CookiesExpiredError, YtdlpService } from '../youtube/ytdlp.service';
import { MIN_DECODABLE_HEIGHT } from '../youtube/constants';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../auth/user.entity';

@Controller('files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly ytdlp: YtdlpService,
    private readonly restore: RestoreService,
    private readonly restoring: RestoreProgress,
  ) {}

  /**
   * One file, or many bundled into one.
   *
   * Many is the interesting case. An upload counts as one whatever it weighs,
   * and a hundred a day is the entire budget: a folder of photos sent one file
   * per request is not slow, it is impossible. Several files arriving together
   * are written into a single tar here and stored as one video, which the whole
   * pipeline downstream then treats as an ordinary file.
   *
   * Entry names come from the browser's `webkitRelativePath`, so folder
   * structure survives — and so does the need to sanitise them.
   */
  @Post()
  @UseInterceptors(FilesInterceptor('file', MAX_BUNDLE_ENTRIES))
  async upload(
    @CurrentUser() user: User,
    @UploadedFiles() uploads?: Express.Multer.File[],
    @Body('name') name?: string,
  ) {
    if (!uploads?.length) throw new BadRequestException('no file in the request');
    if (uploads.length === 1) {
      return this.files.ingest(user.id, uploads[0].path, uploads[0].originalname);
    }
    return this.files.ingestBundle(user.id, uploads, name);
  }

  @Get()
  list(@CurrentUser() user: User) {
    return this.files.list(user.id);
  }

  /**
   * Rebuilds the catalogue from a channel — the answer to an empty file list
   * that is not an empty channel.
   *
   * Here rather than under `/accounts` because what it produces is files: the
   * account is an argument, the same way it is when one is uploaded.
   *
   * Synchronous. Listing a channel is two API calls and a few pages, seconds
   * rather than the minutes a sign-in takes, so there is nothing to poll and
   * no browser to babysit.
   */
  @Post('import')
  async importFromChannel(@CurrentUser() user: User, @Body('accountId') accountId?: string) {
    if (!accountId) throw new BadRequestException('which account? expected {"accountId": "…"}');
    try {
      return await this.files.importFromChannel(user.id, accountId);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id') id: string) {
    return this.files.get(user.id, id);
  }

  /**
   * What YouTube is serving for this file's video, straight from yt-dlp.
   *
   * Exists so nobody has to export a cookie jar to answer that question: a jar
   * used outside the app is rotated by two clients at once and dies. This goes
   * through `withCookies`, so it takes the same lock as everything else.
   */
  @Get(':id/formats')
  async formats(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('probe') probe?: string,
  ) {
    const file = await this.files.get(user.id, id);
    if (!file.videoId || !file.ytAccountId) {
      throw new BadRequestException(`file is ${file.status}; it has no video yet`);
    }

    const renditions = await this.ytdlp.renditions(file.ytAccountId, file.videoId);

    // `?probe=1` turns a listing into a measurement: ten seconds fetched at
    // each rung the decoder could in principle read, and whether it decodes.
    // Only at or above the floor — the smaller rungs cannot be read by any
    // grid, so testing them would spend downloads to confirm the obvious — and
    // one at a time, because these all take the same cookie lock and the point
    // of the table is the answer, not the speed of getting it.
    const checked: Record<string, { ok: boolean; seconds: number; error?: string }> = {};
    if (probe) {
      for (const rendition of renditions) {
        if (rendition.height < MIN_DECODABLE_HEIGHT) continue;
        checked[String(rendition.height)] = await this.restore.probeAt(file, rendition.height);
      }
    }

    return {
      videoId: file.videoId,
      minimum: MIN_DECODABLE_HEIGHT,
      layout: file.layout,
      size: file.size,
      restoreHeight: file.restoreHeight,
      heights: renditions.map((rendition) => rendition.height),
      renditions,
      ...(probe ? { decodes: checked } : {}),
    };
  }

  /**
   * Serves the local copy while one exists, otherwise pulls the video back off
   * YouTube and decodes it. The local copy is only absent once verification has
   * proven YouTube holds a readable version, so the fallback is always safe.
   *
   * `?source=youtube` forces the round trip even when a local copy is present.
   * Without it this route proves nothing about YouTube: a file that has not
   * been verified still has its `sourcePath`, so the answer comes off the disk
   * and yt-dlp is never invoked. Believing otherwise sent a previous
   * investigation looking for a difference between two code paths that are in
   * fact one code path.
   */
  @Get(':id/download')
  async download(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('source') source?: string,
    @Query('inline') inline?: string,
  ) {
    const file = await this.files.get(user.id, id);

    // Headers are set only once there is something to send. Setting them up
    // front meant a failure answered with a JSON error body under a
    // Content-Disposition of attachment, which browsers reject outright:
    // Chrome and Brave report ERR_INVALID_RESPONSE and the real message never
    // reaches anyone.
    // The content never changes: these bytes hash to file.sha256 or they are
    // not this file. So the hash is the ETag, and a browser that already has
    // them revalidates with If-None-Match and gets a 304 — which for a file
    // living on YouTube saves a download and a decode, not just a transfer.
    const etag = `"${file.sha256}"`;

    // Only when the client is asking about the whole thing. A resumed download
    // carries both If-None-Match and Range, and answering that with 304 leaves
    // the browser with the half it already had and no way to finish it.
    if (req.headers['if-none-match'] === etag && !req.headers.range) {
      res.status(304).set({
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600, must-revalidate',
      });
      return;
    }

    const bytes = await this.bytesOf(file, source === 'youtube');
    try {
      // The length comes off the file on disk rather than from the row: an
      // imported row's size is a claim from a description until a decode
      // replaces it, and a Content-Length that disagrees with the body by one
      // byte fails the whole download.
      const stream = serveRange(res, {
        path: bytes.path,
        window: { start: 0, length: statSync(bytes.path).size },
        // Read here rather than reused from above: an imported row has its name
        // and hash replaced by the decode that just ran, and the headers must
        // describe the bytes going out, not the description they were claimed from.
        contentType: inline ? contentTypeOf(file.name) : 'application/octet-stream',
        disposition: dispositionOf(file.name, Boolean(inline)),
        etag: `"${file.sha256}"`,
        range: req.headers.range,
      });

      // A 416 has no body, so nothing will ever close a stream for it.
      if (!stream) bytes.cleanup?.();
      else if (bytes.cleanup) stream.getStream().on('close', bytes.cleanup);
      return stream ?? undefined;
    } catch (error) {
      bytes.cleanup?.();
      throw error;
    }
  }

  /**
   * Every file inside a bundle, without downloading the bundle.
   *
   * Listing walks the 512-byte tar headers and seeks past the data, so it reads
   * kilobytes of a multi-gigabyte archive. Getting the archive there in the
   * first place is the expensive part, and the restore cache means that happens
   * once.
   */
  @Get(':id/entries')
  async entries(@CurrentUser() user: User, @Param('id') id: string) {
    const file = await this.files.get(user.id, id);
    if (!isTarName(file.name)) {
      throw new BadRequestException(`${file.name} is not a bundle`);
    }

    try {
      return { name: file.name, entries: await this.restore.entries(file) };
    } catch (error) {
      if (error instanceof CookiesExpiredError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * One file out of a bundle, by its position in the listing.
   *
   * Served as a byte range, so pulling one photo out of a folder of two hundred
   * reads only that photo — the whole point of keeping the offsets from the
   * listing. When the archive is still on YouTube that range is a run of
   * groups, which is a few seconds of video rather than all of it; when it is
   * already on disk it is a range of the file. `entryBytes` decides which, and
   * hands back a path either way.
   */
  @Get(':id/entries/:index/download')
  async entry(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('index') index: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('inline') inline?: string,
  ) {
    const file = await this.files.get(user.id, id);
    if (!isTarName(file.name)) throw new BadRequestException(`${file.name} is not a bundle`);

    const items = await this.restore.entries(file);
    const item = items[Number(index)];
    if (!item) throw new NotFoundException(`no entry ${index} in ${file.name}`);

    const bytes = await this.restore.entryBytes(file, item);
    try {
      const leaf = item.name.split('/').pop() ?? item.name;
      // `entryBytes` returns either the whole archive, where the entry is a
      // range of it, or just the entry, where it is the whole file. `isSlice`
      // is which — reading a range out of a file that is only the entry would
      // seek past the end of it.
      const start = bytes.isSlice ? 0 : item.offset;
      const stream = serveRange(res, {
        path: bytes.path,
        window: { start, length: item.size },
        contentType: inline ? contentTypeOf(leaf) : 'application/octet-stream',
        disposition: dispositionOf(leaf, Boolean(inline)),
        // The archive's hash plus the entry pins these exact bytes.
        etag: `"${file.sha256}-${index}"`,
        range: req.headers.range,
      });

      if (!stream) bytes.cleanup?.();
      else if (bytes.cleanup) stream.getStream().on('close', bytes.cleanup);
      return stream ?? undefined;
    } catch (error) {
      bytes.cleanup?.();
      throw error;
    }
  }

  /**
   * The file's bytes on local disk, whatever it takes to get them there.
   *
   * The work is in `RestoreService`; what belongs here is turning its one
   * caller-fixable failure into a 4xx. Expired cookies as a 500 reached the
   * page as yt-dlp's paragraph about --cookies, which reads like a bug in the
   * app rather than an errand on the Accounts page.
   */
  private async bytesOf(file: StoredFile, fromYoutube: boolean): Promise<RestoredBytes> {
    try {
      return await this.restore.bytes(file, fromYoutube);
    } catch (error) {
      if (error instanceof CookiesExpiredError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * How far the restore of this file has got, for a page that is waiting on
   * one. Cheap on purpose: a poll every second while a download runs.
   */
  @Get(':id/restore')
  async restoreProgress(@CurrentUser() user: User, @Param('id') id: string) {
    // Through the service so one user cannot watch another's restore, and so
    // an unknown id is a 404 rather than a permanent 'idle'.
    await this.files.get(user.id, id);
    return this.restoring.get(id);
  }

  /**
   * Renames a file here and on the channel.
   *
   * `stale` counts the videos YouTube refused to retitle, which is how an
   * account connected before the write scope existed says so: the rename
   * itself always went through.
   */
  @Post(':id/name')
  async rename(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: { name?: string },
  ) {
    const { file, stale } = await this.files.rename(user.id, id, body.name ?? '');
    return {
      id: file.id,
      name: file.name,
      stale,
      ...(stale
        ? {
            message:
              `renamed here, but ${stale} video${stale === 1 ? '' : 's'} kept the old title - ` +
              'reconnect the account to let this app rename on YouTube too',
          }
        : {}),
    };
  }

  /** Puts a failed file back on the queue it stopped at, from whatever is still on disk. */
  @Post(':id/retry')
  retry(@CurrentUser() user: User, @Param('id') id: string) {
    return this.files.retry(user.id, id);
  }

  /**
   * `?youtube=1` deletes the videos as well, which needs the write scope the
   * accounts page reports as `canManage`. Off by default: forgetting a row is
   * reversible from the channel, and deleting the channel's copy is not.
   */
  @Delete(':id')
  async remove(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('youtube') youtube?: string,
  ) {
    await this.files.remove(user.id, id, youtube === '1' || youtube === 'true');
    return { deleted: id, youtube: youtube === '1' || youtube === 'true' };
  }
}

/**
 * Enough of a media type for the preview to work, from the name alone.
 *
 * Nothing is sniffed from the bytes: the payload came back from YouTube and is
 * rendered in the owner's browser, so an unknown type stays
 * application/octet-stream and the UI offers a download instead of guessing.
 */
const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export function contentTypeOf(name: string): string {
  const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}
