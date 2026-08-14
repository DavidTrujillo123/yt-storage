import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Runs the BullMQ processors with no HTTP listener. Encoding and decoding are
 * CPU-bound loops that would otherwise block every incoming request.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule.register(true));
  const log = new Logger('worker');

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
