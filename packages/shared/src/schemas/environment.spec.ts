import { describe, expect, it } from 'vitest';
import { environmentSchema } from './environment.js';

describe('environmentSchema', () => {
  it('supplies common defaults when local storage is explicitly selected', () => {
    const env = environmentSchema.parse({ STORAGE_DRIVER: 'local' });
    expect(env.API_PORT).toBe(3000);
    expect(env.MONGO_URI).toContain('hala_crm');
    expect(env.STORAGE_DRIVER).toBe('local');
  });

  it('rejects an invalid listening port at boot', () => {
    expect(() => environmentSchema.parse({ API_PORT: '70000' })).toThrow();
  });

  it('defaults to Hostinger and requires its authenticated endpoint and key', () => {
    expect(() => environmentSchema.parse({})).toThrow();
    expect(environmentSchema.parse({ NODE_ENV: 'test' }).STORAGE_DRIVER).toBe('hostinger');
    expect(environmentSchema.parse({
      HOSTINGER_STORAGE_API_URL: 'https://files.example.test/api', HOSTINGER_STORAGE_API_KEY: 'x'.repeat(40) }))
      .toMatchObject({ STORAGE_DRIVER: 'hostinger' });
  });
});
