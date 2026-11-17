import './load-env.js';
import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { validateEnvironment } from './config/environment.js';
import { ObserveInstrument } from './observe.js';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter.js';

async function bootstrap(): Promise<void> {
  const env = validateEnvironment(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true, instrument: ObserveInstrument, rawBody: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: env.CORS_ORIGINS.split(',').map(origin => origin.trim()), credentials: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix('api/v1');
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Hala CRM API').setVersion('0.1.0').addBearerAuth().build());
  SwaggerModule.setup('docs', app, document);
  await app.listen(env.API_PORT);
}

void bootstrap();
