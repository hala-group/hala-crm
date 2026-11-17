import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccountSchema } from './schemas/accounts.js';
import { decryptSecret, encryptSecret } from './secrets.js';

describe('Cloud credentials', () => {
  it('requires complete Cloud config and keeps it out of Baileys accounts', () => {
    expect(createAccountSchema.safeParse({ label: 'Cloud', provider: 'cloud_api' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ label: 'Cloud', provider: 'cloud_api', cloud: {
      phoneNumberId: '1234567890', wabaId: '1234567890', accessToken: 'long-cloud-access-token'
    } }).success).toBe(true);
    expect(createAccountSchema.safeParse({ label: 'Baileys', cloud: {
      phoneNumberId: '1234567890', wabaId: '1234567890', accessToken: 'long-cloud-access-token'
    } }).success).toBe(false);
  });

  it('encrypts with a unique nonce and rejects wrong keys or changed ciphertext', () => {
    const key = randomBytes(32).toString('base64');
    const other = randomBytes(32).toString('base64');
    const first = encryptSecret('private-access-token', key);
    const second = encryptSecret('private-access-token', key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe('private-access-token');
    expect(() => decryptSecret(first, other)).toThrow();
    const bytes = Buffer.from(first, 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(() => decryptSecret(bytes.toString('base64'), key)).toThrow();
  });
});
