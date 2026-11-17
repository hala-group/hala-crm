import { type Connection, Types } from 'mongoose';
import { type ProviderCallEvent, type DomainEvent } from '@hala/shared';

export class CallProcessor {
  constructor(private readonly db: Connection, private readonly publish: (event: DomainEvent) => Promise<void>) {}

  async process(event: ProviderCallEvent): Promise<void> {
    const tenantId = new Types.ObjectId(event.tenantId);
    const accountId = new Types.ObjectId(event.accountId);
    const waId = event.waId.replace(/^([0-9]+):[0-9]+@(lid|s\.whatsapp\.net)$/, '$1@$2');
    const contacts = this.db.collection('contacts');
    const calls = this.db.collection('calls');
    const contact = await contacts.findOne({ tenantId, lid: waId })
      ?? await contacts.findOne({ tenantId, waId })
      ?? await contacts.findOneAndUpdate({ tenantId, waId }, {
        $setOnInsert: { tenantId, waId, isGroup: waId.endsWith('@g.us'), tags: [], customFields: {}, createdAt: new Date() }
      }, { upsert: true, returnDocument: 'after' });
    if (!contact) throw new Error('Call contact missing');
    await this.db.collection('conversations').updateOne({ tenantId, accountId, contactId: contact._id }, {
      $setOnInsert: { tenantId, accountId, contactId: contact._id, status: 'open', unreadCount: 0,
        lastMessageAt: new Date(event.startedAt), lastMessagePreview: '', lastMessageType: 'system',
        lastMessageDirection: event.direction, createdAt: new Date(), updatedAt: new Date() },
      $max: { lastCallAt: new Date(event.startedAt) }
    }, { upsert: true });
    const prior = await calls.findOne({ tenantId, accountId, waCallId: event.waCallId });
    // If a call was ringing and then terminates without ever being accepted, it was missed
    let effectiveStatus = event.status;
    if (prior?.status === 'ringing' && event.status === 'ended') {
      effectiveStatus = 'missed';
    }

    const next = await calls.findOneAndUpdate({ tenantId, accountId, waCallId: event.waCallId }, {
      $setOnInsert: { tenantId, accountId, waCallId: event.waCallId,
        direction: event.direction, isVideo: event.isVideo, startedAt: new Date(event.startedAt), createdAt: new Date() },
      $set: { contactId: contact._id, status: effectiveStatus, updatedAt: new Date(),
        ...(effectiveStatus === 'missed' || effectiveStatus === 'rejected' || effectiveStatus === 'ended' ? { endedAt: new Date() } : {}) }
    }, { upsert: true, returnDocument: 'after' });
    if (event.direction === 'in' && next && prior?.status !== effectiveStatus && (effectiveStatus === 'ringing' || effectiveStatus === 'missed')) {
      await this.publish({ type: effectiveStatus === 'ringing' ? 'call.incoming' : 'call.missed',
        tenantId: event.tenantId, accountId: event.accountId, callId: next._id.toString(),
        waCallId: event.waCallId, contactId: contact._id.toString(), isVideo: event.isVideo });
    }
  }
}
