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
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { createReadStream, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isTarName, listTar } from './tar';
import { MAX_BUNDLE_ENTRIES } from './bundle';
import type { Request, Response } from 'express';
import { FilesService } from './files.service';
import type { StoredFile } from './stored-file.entity';
import { RestoreCache } from './restore-cache';
import { CodecService } from '../codec/codec.service';
import { YtdlpService } from '../youtube/ytdlp.service';
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
    private readonly codec: CodecService,
    private readonly cache: RestoreCache,
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
  async formats(@CurrentUser() user: User, @Param('id') id: string) {
    const file = await this.files.get(user.id, id);
    if (!file.videoId || !file.ytAccountId) {
      throw new BadRequestException(`file is ${file.status}; it has no video yet`);
    }
    return {
      videoId: file.videoId,
      minimum: MIN_DECODABLE_HEIGHT,
      heights: await this.ytdlp.availableHeights(file.ytAccountId, file.videoId),
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

    // Read at send time rather than reused from above: an imported row has its
    // name and hash replaced by the decode that just ran, and the headers must
    // describe the bytes going out, not the description they were claimed from.
    const send = (path: string, onClose?: () => void) => {
      res.set({
        'Content-Type': inline ? contentTypeOf(file.name) : 'application/octet-stream',
        'Content-Disposition':
          `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.name)}"`,
        ETag: `"${file.sha256}"`,
        'Cache-Control': 'private, max-age=3600, must-revalidate',
      });
      const stream = createReadStream(path);
      if (onClose) stream.on('close', onClose);
      return new StreamableFile(stream);
    };

    if (req.headers['if-none-match'] === etag) {
      res.status(304).set({ ETag: etag, 'Cache-Control': 'private, max-age=3600, must-revalidate' });
      return;
    }

    const bytes = await this.bytesOf(file, source === 'youtube');
    return send(bytes.path, bytes.cleanup);
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

    const bytes = await this.bytesOf(file, false);
    try {
      return { name: file.name, entries: await listTar(bytes.path) };
    } finally {
      bytes.cleanup?.();
    }
  }

  /**
   * One file out of a bundle, by its position in the listing.
   *
   * Served as a byte range of the archive, so pulling one photo out of a folder
   * of two hundred reads only that photo — the whole point of keeping the
   * offsets from the listing.
   */
  @Get(':id/entries/:index/download')
  async entry(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('index') index: string,
    @Res({ passthrough: true }) res: Response,
    @Query('inline') inline?: string,
  ) {
    const file = await this.files.get(user.id, id);
    if (!isTarName(file.name)) throw new BadRequestException(`${file.name} is not a bundle`);

    const bytes = await this.bytesOf(file, false);
    try {
      const items = await listTar(bytes.path);
      const item = items[Number(index)];
      if (!item) throw new NotFoundException(`no entry ${index} in ${file.name}`);

      const leaf = item.name.split('/').pop() ?? item.name;
      res.set({
        'Content-Type': inline ? contentTypeOf(leaf) : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(leaf)}"`,
        'Content-Length': String(item.size),
        // The archive's hash plus the entry pins these exact bytes.
        ETag: `"${file.sha256}-${index}"`,
        'Cache-Control': 'private, max-age=3600, must-revalidate',
      });

      // An empty entry has no range to read; end must not go below start.
      const stream =
        item.size === 0
          ? createReadStream(bytes.path, { start: 0, end: -1 })
          : createReadStream(bytes.path, { start: item.offset, end: item.offset + item.size - 1 });
      if (bytes.cleanup) stream.on('close', bytes.cleanup);
      return new StreamableFile(stream);
    } catch (error) {
      bytes.cleanup?.();
      throw error;
    }
  }

  /**
   * The file's bytes on local disk, whatever it takes to get them there:
   * the original copy, then the restore cache, then YouTube.
   *
   * `cleanup` is set only when the caller is responsible for scratch — which
   * happens only if the cache refused the file.
   */
  private async bytesOf(
    file: StoredFile,
    fromYoutube: boolean,
  ): Promise<{ path: string; cleanup?: () => void }> {
    if (!fromYoutube && file.sourcePath && existsSync(file.sourcePath)) {
      return { path: file.sourcePath };
    }

    if (!file.videoId || !file.ytAccountId) {
      throw new BadRequestException(`file is ${file.status}; nothing to download yet`);
    }

    // Restored once, kept until evicted. Everything below this line costs a
    // full video download and decode, so it runs at most once per set of bytes.
    if (!fromYoutube) {
      const cached = await this.cache.get(file.sha256);
      if (cached) return { path: cached };
    }

    // A fresh directory every time. yt-dlp writes the video straight to this
    // path (--no-part), so anything left by an interrupted attempt makes it
    // try to resume a file it has no range for: "HTTP Error 416: Requested
    // range not satisfiable", on every attempt after the first.
    const dir = this.files.workDir('restore', file.id);
    await rm(dir, { recursive: true, force: true });
    await this.files.ensureDir('restore', file.id);

    const videoPath = join(dir, 'download.mp4');
    try {
      await this.ytdlp.download(file.ytAccountId, file.videoId, videoPath);
      const result = await this.codec.decode(videoPath, dir);

      if (file.importedAt) {
        // A row read back off the channel knows only what the description said.
        // The container header is the authority — it is what the bytes actually
        // are — so this is where an imported row stops being a claim. Refusing a
        // mismatch here would refuse the file for disagreeing with its own
        // description, which is the one thing that was never verified.
        await this.files.confirmImported(file, result);
      } else if (result.sha256 !== file.sha256) {
        throw new BadRequestException(`recovered data does not match the stored hash for ${file.name}`);
      }

      // Into the cache before the scratch directory goes, so the next read of
      // these bytes — a download, a listing, one entry — is a file read.
      const cached = await this.cache.put(result.sha256, result.name);
      if (cached) {
        await rm(dir, { recursive: true, force: true });
        return { path: cached };
      }

      return { path: result.name, cleanup: () => void rm(dir, { recursive: true, force: true }) };
    } catch (error) {
      // Leaving the scratch behind is what caused the 416 in the first place.
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Puts a failed file back on the queue it stopped at, from whatever is still on disk. */
  @Post(':id/retry')
  retry(@CurrentUser() user: User, @Param('id') id: string) {
    return this.files.retry(user.id, id);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    await this.files.remove(user.id, id);
    return { deleted: id };
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
