import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { ExceptionLogger } from './common/exception-logger';

/**
 * One process, one port: the API under /api and the UI on everything else.
 *
 * A separate frontend server would mean either CORS or a proxy, and the session
 * cookie is httpOnly — nothing in the page can carry it by hand, so it only
 * works when the two are the same origin. Serving both from here makes that
 * true by construction.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(false));

  // Google's OAuth callback is registered in every user's Cloud project as
  // /accounts/callback. Moving it under the prefix would silently break every
  // account already connected, so it keeps its address.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'accounts/callback', method: RequestMethod.GET }],
  });

  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ExceptionLogger());
  app.enableShutdownHooks();

  // The UI is a static export: one .html per route, no server of its own.
  // `extensions` is what maps /files to files.html. Static middleware runs
  // before the router but matches no file under /api, so the two never
  // compete.
  const webDir = resolve(process.env.WEB_DIR ?? '../web/out');
  if (existsSync(webDir)) {
    app.useStaticAssets(webDir, { extensions: ['html'] });
  } else {
    new Logger('bootstrap').warn(`no UI at ${webDir}; run pnpm build to produce it`);
  }

  // Node cuts a request off after five minutes by default, and does it by
  // destroying the socket: no exception, no log, and the browser sees only a
  // network error. That is a poor fit for an app whose whole purpose is large
  // files, so uploads get two hours. headersTimeout must stay above it or the
  // shorter one wins.
  const server = app.getHttpServer();
  server.requestTimeout = 2 * 60 * 60 * 1000;
  server.headersTimeout = server.requestTimeout + 60_000;

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('bootstrap').log(`listening on http://localhost:${port} - UI at /, API at /api`);
}

void bootstrap();
