import { type Connection, Types } from 'mongoose';
import { type ProviderAccount, type SessionStatusEvent } from '@hala/shared';
import { type SessionAccount, type SessionRepository } from './session.manager.js';

interface AccountDocument {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  provider: 'baileys' | 'cloud_api';
  desiredState: 'connected' | 'disconnected';
}

export class MongoSessionRepository implements SessionRepository {
  constructor(private readonly connection: Connection) {}
  private asAccount(record: AccountDocument): SessionAccount {
    return { id: record._id.toString(), tenantId: record.tenantId.toString(), desiredState: record.desiredState, provider: record.provider };
  }
  async desiredAccounts(): Promise<SessionAccount[]> {
    const records = await this.connection.collection<AccountDocument>('whatsapp_accounts')
      .find({ desiredState: 'connected', provider: { $in: ['baileys', 'cloud_api'] } }).project<AccountDocument>({ _id: 1, tenantId: 1, desiredState: 1, provider: 1 }).toArray();
    return records.map(record => this.asAccount(record));
  }
  async get(id: string): Promise<SessionAccount | null> {
    const record = await this.connection.collection<AccountDocument>('whatsapp_accounts').findOne({ _id: new Types.ObjectId(id) });
    return record ? this.asAccount(record) : null;
  }
  async update(event: SessionStatusEvent, workerId: string): Promise<void> {
    const accountId = new Types.ObjectId(event.accountId);
    const tenantId = new Types.ObjectId(event.tenantId);
    if (event.type === 'wa.qr') {
      await this.connection.collection('whatsapp_accounts').updateOne({ _id: accountId, tenantId, desiredState: 'connected' },
        { $set: { status: 'qr_pending', assignedWorkerId: workerId, leaseUpdatedAt: new Date() } });
      return;
    }
    const fields: Record<string, unknown> = {
      status: event.status, assignedWorkerId: workerId, leaseUpdatedAt: new Date(), lastError: event.error
    };
    if (event.status === 'connected') fields['lastConnectedAt'] = new Date();
    if (event.status === 'connected' && event.ownJid) fields['ownJid'] = event.ownJid;
    if (event.status === 'connected' && event.ownLid) fields['ownLid'] = event.ownLid;
    if (event.status === 'logged_out') fields['desiredState'] = 'disconnected';
    if (event.phoneNumber?.endsWith('@s.whatsapp.net')) fields['phoneNumber'] = event.phoneNumber.split('@')[0]?.split(':')[0];
    else if (event.phoneNumber && /^\+?[\d\s()-]{6,25}$/.test(event.phoneNumber)) fields['phoneNumber'] = event.phoneNumber;
    const clearOldLid = event.status === 'connected' && Boolean(event.ownJid) && !event.ownLid;
    await this.connection.collection('whatsapp_accounts').updateOne({ _id: accountId, tenantId }, {
      $set: fields, ...(clearOldLid ? { $unset: { ownLid: '' } } : {})
    });
  }
  async clearAuth(account: ProviderAccount): Promise<void> {
    await this.connection.collection('wa_auth_states').deleteMany({
      tenantId: new Types.ObjectId(account.tenantId), accountId: new Types.ObjectId(account.id)
    });
  }
}
