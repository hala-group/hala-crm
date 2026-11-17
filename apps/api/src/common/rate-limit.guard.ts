import { CanActivate, ExecutionContext, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { type Request } from 'express';
import { RedisBusService } from '../modules/access/redis-bus.service.js';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(RedisBusService) private readonly redis: RedisBusService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request & { principal?: { id: string; tenantId: string } }>();
    const method = request.method;
    const path = request.route?.path ?? request.path;
    const auth = path.includes('/auth/');
    const isWebhook = path.includes('/webhooks/');
    const limit = auth ? 20 : isWebhook ? 600 : method === 'GET' ? 300 : 100;
    const identity = request.principal ? `${request.principal.tenantId}:${request.principal.id}` : request.ip ?? 'unknown';
    const key = createHash('sha256').update(`${identity}:${method}:${path}`).digest('hex');
    let allowed: boolean;
    try { allowed = await this.redis.consume(`rate:http:${key}`, limit, 60); }
    catch { throw new ServiceUnavailableException('Rate limiter unavailable'); }
    if (!allowed) throw new ThrottlerException();
    return true;
  }
}
