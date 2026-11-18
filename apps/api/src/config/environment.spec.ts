import { describe, expect, it } from 'vitest';
import { apiEnvironmentSchema } from './environment.js';

const base = { NODE_ENV: 'test', STORAGE_DRIVER: 'local', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) };
const serviceAccount = Buffer.from(JSON.stringify({ project_id: 'hala-message-test',
  client_email: 'firebase-admin@example.invalid', private_key: 'test-private-key' })).toString('base64');
const firebase = {
  FIREBASE_PROJECT_ID: 'hala-message-test', FIREBASE_WEB_API_KEY: 'public-api-key',
  FIREBASE_AUTH_DOMAIN: 'hala-message-test.firebaseapp.com', FIREBASE_MESSAGING_SENDER_ID: '1234567890',
  FIREBASE_APP_ID: '1:1234567890:web:abcdef', FIREBASE_VAPID_KEY: 'public-vapid-key',
  FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64: serviceAccount
};

describe('API Firebase environment', () => {
  it('rejects conflicting Firebase and call VAPID keys for the shared browser subscription', () => {
    expect(apiEnvironmentSchema.safeParse({ ...base, ...firebase, VAPID_PUBLIC_KEY: 'other-key',
      VAPID_PRIVATE_KEY: 'private', VAPID_SUBJECT: 'mailto:admin@example.invalid' }).success).toBe(false);
  });
  it('accepts a complete Firebase web and Admin configuration', () => {
    expect(apiEnvironmentSchema.safeParse({ ...base, ...firebase }).success).toBe(true);
  });

  it('requires all Firebase settings together', () => {
    expect(apiEnvironmentSchema.safeParse({ ...base, FIREBASE_PROJECT_ID: firebase.FIREBASE_PROJECT_ID }).success).toBe(false);
  });

  it('rejects a service account from a different Firebase project', () => {
    const mismatched = Buffer.from(JSON.stringify({ project_id: 'different-project',
      client_email: 'firebase-admin@example.invalid', private_key: 'test-private-key' })).toString('base64');
    expect(apiEnvironmentSchema.safeParse({ ...base, ...firebase,
      FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64: mismatched }).success).toBe(false);
  });
});
