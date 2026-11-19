import { type ContactAccountIdentity } from '@hala/shared';

export function accountIdentity(record: Record<string, unknown>): ContactAccountIdentity {
  return { phoneNumber: typeof record['phoneNumber'] === 'string' ? record['phoneNumber'] : undefined,
    ownJid: typeof record['ownJid'] === 'string' ? record['ownJid'] : undefined,
    ownLid: typeof record['ownLid'] === 'string' ? record['ownLid'] : undefined };
}
