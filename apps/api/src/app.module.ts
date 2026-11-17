import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from 'nestjs-pino';
import { validateEnvironment } from './config/environment.js';
import { HealthController } from './modules/health/health.controller.js';
import { ObserveModule } from './observe.js';
import { AccessGuard } from './common/access.guard.js';
import { PoliciesGuard } from './common/policies.guard.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';
import { PersistenceModule } from './modules/persistence.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { RolesModule } from './modules/roles/roles.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { AccountsModule } from './modules/whatsapp-accounts/accounts.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { CallsModule } from './modules/calls/calls.module.js';
import { CloudWebhookModule } from './modules/cloud-webhook/cloud-webhook.module.js';
import { tenantContextMiddleware } from './common/tenant-context.js';

@Module({
  imports: [
    ObserveModule.forRoot({ serviceId: 'hala-api', enabled: Boolean(process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET) }),
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    MongooseModule.forRootAsync({ useFactory: () => ({ uri: validateEnvironment(process.env).MONGO_URI }) }),
    JwtModule.register({ global: true }),
    LoggerModule.forRoot({ pinoHttp: { autoLogging: false, redact: { paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.accessToken',
      'req.body.cloud.accessToken', 'req.body.token', 'res.headers.set-cookie'
    ], censor: '[REDACTED]' } } }),
    TerminusModule,
    PersistenceModule,
    AccessModule,
    AccountsModule,
    RealtimeModule,
    InboxModule,
    CallsModule,
    CloudWebhookModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: PoliciesGuard }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(tenantContextMiddleware).forRoutes('*');
  }
}
