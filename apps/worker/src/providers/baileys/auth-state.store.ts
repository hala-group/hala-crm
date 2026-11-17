import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type Connection, Types } from 'mongoose';
import { BufferJSON, initAuthCreds, type AuthenticationState, type SignalDataTypeMap, type SignalDataSet } from '@whiskeysockets/baileys';
import { type ProviderAccount } from '@hala/shared';
import { LeaseService } from '../../session/lease.service.js';

interface StoredAuth { tenantId: Types.ObjectId; accountId: Types.ObjectId; key: string; valueEnc: string; fencingToken: number }

export class EncryptedAuthStateStore {
  private readonly key: Buffer;
  constructor(private readonly connection: Connection, private readonly leases: LeaseService, keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('ENCRYPTION_KEY_BASE64 must decode to 32 bytes');
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plain = Buffer.from(JSON.stringify(value, BufferJSON.replacer));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
  }

  private decrypt<T>(value: string): T {
    const [iv, tag, ciphertext] = value.split('.');
    if (!iv || !tag || !ciphertext) throw new Error('Invalid auth state');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString(), BufferJSON.reviver) as T;
  }

  async load(account: ProviderAccount, fencingToken: number): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    const tenantId = new Types.ObjectId(account.tenantId);
    const accountId = new Types.ObjectId(account.id);
    const collection = this.connection.collection<StoredAuth>('wa_auth_states');
    const read = async <T>(key: string): Promise<T | null> => {
      const record = await collection.findOne({ tenantId, accountId, key });
      if (!record) return null;
      try {
        return this.decrypt<T>(record.valueEnc);
      } catch {
        return null;
      }
    };
    const write = async (key: string, value: unknown): Promise<void> => {
      await this.leases.assertOwned({ accountId: account.id, workerId: this.leases.workerId, fencingToken });
      if (value === null || value === undefined) {
        await collection.deleteOne({ tenantId, accountId, key });
        return;
      }
      await collection.updateOne(
        { tenantId, accountId, key },
        { $set: { valueEnc: this.encrypt(value), fencingToken, updatedAt: new Date() }, $setOnInsert: { tenantId, accountId, key, createdAt: new Date() } },
        { upsert: true }
      );
    };
    const creds = (await read<AuthenticationState['creds']>('creds')) ?? initAuthCreds();
    const state: AuthenticationState = {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(ids.map(async id => {
            const value = await read<SignalDataTypeMap[T]>(`${type}:${id}`);
            if (value) result[id] = value;
          }));
          return result;
        },
        set: async (data: SignalDataSet) => {
          for (const [type, values] of Object.entries(data)) {
            if (!values) continue;
            for (const [id, value] of Object.entries(values)) await write(`${type}:${id}`, value);
          }
        },
        clear: async () => {
          await this.leases.assertOwned({ accountId: account.id, workerId: this.leases.workerId, fencingToken });
          await collection.deleteMany({ tenantId, accountId });
        }
      }
    };
    return { state, saveCreds: () => write('creds', state.creds) };
  }
}
