import './load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';
import { ObserveInstrument } from './observe.js';

async function bootstrap(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    // Prevent unhandled background promise rejections (e.g. Baileys query timeouts) from killing the process
    console.warn('Unhandled worker rejection:', reason);
  });
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true, instrument: ObserveInstrument });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}

void bootstrap();
