import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Logs every rejected request, with the reason intact.
 *
 * Nest's default filter answers 4xx silently, which is reasonable for a public
 * API and useless here: an upload rejected by multer mid-stream reaches the
 * browser as a dropped connection, and the server-side record of *why* did not
 * exist at all. Two hours went into a "connection dropped" that the server
 * could have explained in one line.
 *
 * Multer's own errors carry a `code` (LIMIT_FILE_SIZE, LIMIT_UNEXPECTED_FILE,
 * LIMIT_PART_COUNT…) which says exactly which limit was hit, so it is pulled
 * out and logged rather than flattened into "Bad Request".
 */
@Catch()
export class ExceptionLogger implements ExceptionFilter {
  private readonly log = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const code = (exception as { code?: string }).code;
    const field = (exception as { field?: string }).field;
    const message = exception instanceof Error ? exception.message : String(exception);

    const detail = [
      `${request.method} ${request.originalUrl} -> ${status}`,
      code ? `code=${code}` : '',
      field ? `field=${field}` : '',
      message,
    ]
      .filter(Boolean)
      .join(' | ');

    if (status >= 500) this.log.error(detail, exception instanceof Error ? exception.stack : undefined);
    else this.log.warn(detail);

    const body =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message, ...(code ? { code } : {}) };

    // The client may still be sending its body; answering without reading the
    // rest is what the browser reports as a dropped connection, so say so
    // clearly in the payload too.
    if (!response.headersSent) response.status(status).json(body);
  }
}
