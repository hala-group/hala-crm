import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function keyFrom(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY_BASE64 must encode 32 bytes');
  return key;
}

export function encryptSecret(plaintext: string, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(keyBase64), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length < 29) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(keyBase64), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
