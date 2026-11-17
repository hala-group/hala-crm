import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLOUD_API_CAPABILITIES } from '@hala/shared';
import { verifyCloudSignature } from '../src/modules/cloud-webhook/cloud-webhook.controller.js';
import { RedisBusService } from '../src/modules/access/redis-bus.service.js';

describe('Phase 6 Cloud boundary', () => {
  it('requires a valid SHA-256 signature over exact raw request bytes', () => {
    const body = Buffer.from('{"entry":[]}');
    const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
    expect(verifyCloudSignature(body, signature, 'secret')).toBe(true);
    expect(verifyCloudSignature(Buffer.from('{"entry": []}'), signature, 'secret')).toBe(false);
    expect(verifyCloudSignature(body, `sha256=${'a'.repeat(64)}`, 'secret')).toBe(false);
    expect(verifyCloudSignature(body, 'sha256=broken', 'secret')).toBe(false);
    expect(verifyCloudSignature(undefined, signature, 'secret')).toBe(false);
  });

  it('advertises Cloud-only templates and interactive messages without unsupported edits or forwards', () => {
    expect(CLOUD_API_CAPABILITIES).toContain('template');
    expect(CLOUD_API_CAPABILITIES).toContain('interactive');
    expect(CLOUD_API_CAPABILITIES).not.toContain('edit');
    expect(CLOUD_API_CAPABILITIES).not.toContain('forward');
    expect(CLOUD_API_CAPABILITIES).not.toContain('mentions');
  });

  it('limits repeated local requests and fails closed without Redis in production', async () => {
    const previous = process.env.NODE_ENV;
    const bus = new RedisBusService();
    try {
      process.env.NODE_ENV = 'test';
      expect(await bus.consume('phase6:rate', 2, 60)).toBe(true);
      expect(await bus.consume('phase6:rate', 2, 60)).toBe(true);
      expect(await bus.consume('phase6:rate', 2, 60)).toBe(false);
      process.env.NODE_ENV = 'production';
      await expect(bus.consume('phase6:rate', 2, 60)).rejects.toThrow('Rate limiter Redis unavailable');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
      await bus.onModuleDestroy();
    }
  });
});
