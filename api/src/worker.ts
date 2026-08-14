import 'reflect-metadata';
// See main.ts: the key has to be resolved before Nest reads the environment.
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { applySecretKey } from './common/secret-key';

/**
 * Runs the BullMQ processors with no HTTP listener. Encoding and decoding are
 * CPU-bound loops that would otherwise block every incoming request.
 */
async function bootstrap(): Promise<void> {
  const log = new Logger('worker');
  applySecretKey(log);

  const app = await NestFactory.createApplicationContext(AppModule.register(true));

  // Without this a Ctrl+C mid-encode leaves the job "active" in Redis until the
  // stalled-check reclaims it minutes later. enableShutdownHooks lets BullMQ
  // close its workers first.
  app.enableShutdownHooks();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.log(`${signal} received, finishing current job`);
      void app.close().then(() => process.exit(0));
    });
  }

  log.log('worker ready: encode, upload, verify');
}

void bootstrap();
