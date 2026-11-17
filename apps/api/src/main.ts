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

  if (process.env.BOOTSTRAP_TENANT_SLUG && process.env.BOOTSTRAP_OWNER_EMAIL && process.env.BOOTSTRAP_OWNER_PASSWORD) {
    const { getModelToken } = await import('@nestjs/mongoose');
    const { bootstrapTenant } = await import('./modules/tenants/bootstrap-tenant.js');
    try {
      await bootstrapTenant(
        {
          tenants: app.get(getModelToken('Tenant')),
          roles: app.get(getModelToken('Role')),
          users: app.get(getModelToken('User'))
        },
        {
          slug: process.env.BOOTSTRAP_TENANT_SLUG,
          name: process.env.BOOTSTRAP_TENANT_NAME ?? process.env.BOOTSTRAP_TENANT_SLUG,
          ownerEmail: process.env.BOOTSTRAP_OWNER_EMAIL,
          ownerPassword: process.env.BOOTSTRAP_OWNER_PASSWORD
        }
      );
      app.get(Logger).log(`Bootstrap completed for tenant ${process.env.BOOTSTRAP_TENANT_SLUG}`);
    } catch (err) {
      app.get(Logger).error(`Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await app.listen(env.API_PORT);
}

void bootstrap();
