import { type Connection, Types } from 'mongoose';
import { outgoingMessageSchema, type DomainEvent, type MessageView, type OutboundCommand, type ProviderEvent, type ProviderMessageKey, type ProviderSendRequest } from '@hala/shared';
import { type StorageDriver, type StoragePort } from '@hala/shared/storage';
import { SessionManager } from '../session/session.manager.js';

interface Dependencies {
  connection: Connection;
  storage: StoragePort;
  storageForDriver?: (driver: StorageDriver) => StoragePort;
  manager: SessionManager;
  publish: (event: DomainEvent) => Promise<void>;
}
interface StoredMessage {
  tenantId: Types.ObjectId; accountId: Types.ObjectId; conversationId: Types.ObjectId; contactId: Types.ObjectId;
  waMessageId: string; clientMessageId?: string; direction: 'in' | 'out'; type: MessageView['type'];
  timestamp: Date; status: MessageView['status']; statusHistory: { status: string; at: Date }[];
  outbound?: unknown; mediaId?: Types.ObjectId; text?: string; caption?: string;
  pendingEditText?: string; editedAt?: Date; revokedAt?: Date;
  raw?: { remoteJid?: string; participant?: string; messageType?: string };
}

export class OutboundProcessor {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly deps: Dependencies) { }

  async process(command: OutboundCommand): Promise<void> {
    const previous = this.locks.get(command.accountId) ?? Promise.resolve();
    const current = previous.catch(() => { }).then(() => this.execute(command));
    this.locks.set(command.accountId, current);
    try { await current; }
    finally { if (this.locks.get(command.accountId) === current) this.locks.delete(command.accountId); }
  }

  private async execute(command: OutboundCommand): Promise<void> {
    const db = this.deps.connection.db!;
    const tenantId = new Types.ObjectId(command.tenantId);
    const accountId = new Types.ObjectId(command.accountId);
    const messageId = new Types.ObjectId(command.messageId);
    const messages = db.collection<StoredMessage>('messages');
    const message = await messages.findOne({ _id: messageId, tenantId, accountId });
    if (!message) throw new Error('Outbound message missing');
    const conversation = await db.collection('conversations').findOne({ _id: message['conversationId'], tenantId, accountId });
    if (!conversation) throw new Error('Outbound conversation missing');
    const contact = await db.collection('contacts').findOne({ _id: conversation['contactId'], tenantId });
    if (!contact?.['waId']) throw new Error('Outbound contact missing');
    const account = await db.collection('whatsapp_accounts').findOne({ _id: accountId, tenantId });
    if (!account) throw new Error('Outbound account missing');
    if (account['cleanup']) return;
    const jid = contact['waId'] as string;
    const isGroup = Boolean(contact['isGroup'] || conversation['isGroup']);
    try {
      if (command.operation === 'send' || command.operation === 'forward') {
        if (message['status'] === 'sent' || message['status'] === 'delivered' || message['status'] === 'read') return;
        const input = outgoingMessageSchema.parse(message['outbound']);
        const min = Math.max(0, Number(account['settings']?.['sendPacing']?.['minDelayMs'] ?? 500));
        const max = Math.max(min, Number(account['settings']?.['sendPacing']?.['maxDelayMs'] ?? 1500));
        await new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
        let media: Uint8Array | undefined;
        let mimeType: string | undefined;
        let fileName: string | undefined;
        if ('mediaId' in input) {
          const asset = await db.collection('media').findOne({ _id: new Types.ObjectId(input.mediaId), tenantId, accountId, status: 'ready' });
          if (!asset) throw new Error('MEDIA_MISSING');
          const driver = asset['storageDriver'];
          const storage = driver === 'local' || driver === 's3' || driver === 'hostinger'
            ? this.deps.storageForDriver?.(driver) ?? this.deps.storage : this.deps.storage;
          const stored = await storage.open(asset['storageKey'] as string);
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stored.stream) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > Number(process.env.MEDIA_MAX_BYTES ?? 100 * 1024 * 1024)) throw new Error('MEDIA_TOO_LARGE');
            chunks.push(bytes);
          }
          media = Buffer.concat(chunks);
          mimeType = asset['mimeType'] as string;
          fileName = asset['fileName'] as string | undefined;
        }
        let quoted: ProviderMessageKey | undefined;
        let quotedText: string | undefined;
        if (input.replyToMessageId) {
          const related = await messages.findOne({
            _id: new Types.ObjectId(input.replyToMessageId), tenantId, accountId,
            conversationId: conversation._id
          });
          if (!related) throw new Error('REPLY_TARGET_MISSING');
          const rawParticipant = (related['raw'] as Record<string, unknown> | undefined)?.['participant'] as string | undefined;
          const rawRemoteJid = (related['raw'] as Record<string, unknown> | undefined)?.['remoteJid'] as string | undefined;
          quoted = { jid: rawRemoteJid || jid, id: related['waMessageId'] as string, fromMe: related['direction'] === 'out', participant: isGroup ? rawParticipant : undefined };
          quotedText = related['text'] as string | undefined;
        }
        let target: ProviderMessageKey | undefined;
        if (input.type === 'reaction') {
          const related = await messages.findOne({
            _id: new Types.ObjectId(input.targetMessageId), tenantId, accountId,
            conversationId: conversation._id
          });
          if (!related) throw new Error('REACTION_TARGET_MISSING');
          const rawParticipant = (related['raw'] as Record<string, unknown> | undefined)?.['participant'] as string | undefined;
          const rawRemoteJid = (related['raw'] as Record<string, unknown> | undefined)?.['remoteJid'] as string | undefined;
          target = { jid: rawRemoteJid || jid, id: related['waMessageId'] as string, fromMe: related['direction'] === 'out', participant: isGroup ? rawParticipant : undefined };
        }
        const request: ProviderSendRequest = { jid, input, messageId: message['waMessageId'] as string,
          media, mimeType, fileName, quoted, quotedText, target, forwarded: command.operation === 'forward' };
        const waMessageId = await this.deps.manager.send(command.accountId, command.tenantId, request);
        const update = await messages.updateOne({ _id: messageId, tenantId, accountId, status: { $in: ['pending', 'failed'] } }, {
          $set: { status: 'sent', waMessageId, updatedAt: new Date() },
          $unset: { failureReason: '' }, $push: { statusHistory: { status: 'sent', at: new Date() } }
        });
        if (update.modifiedCount) {
          await db.collection('conversations').updateOne({ _id: conversation['_id'], tenantId, accountId, lastMessageAt: { $lte: message['timestamp'] as Date } },
            { $set: { lastMessageStatus: 'sent' } });
          await this.publishStatus(command, conversation, 'sent', waMessageId);
        }
      } else if (command.operation === 'edit') {
        const text = message['pendingEditText'] as string | undefined;
        if (!text) return;
        await this.deps.manager.edit(command.accountId, command.tenantId, jid,
          { jid, id: message['waMessageId'] as string, fromMe: true }, text);
        await messages.updateOne({ _id: messageId, tenantId, accountId }, { $set: { text, editedAt: new Date() }, $unset: { pendingEditText: '' } });
        await this.publishUpdated(command, conversation);
      } else if (command.operation === 'revoke') {
        if (message['revokedAt']) return;
        await this.deps.manager.revoke(command.accountId, command.tenantId, jid,
          { jid, id: message['waMessageId'] as string, fromMe: true });
        await messages.updateOne({ _id: messageId, tenantId, accountId }, { $set: { revokedAt: new Date(), updatedAt: new Date() } });
        await this.publishUpdated(command, conversation);
      } else if (command.operation === 'read') {
        const rawRemoteJid = (message['raw'] as Record<string, unknown> | undefined)?.['remoteJid'] as string | undefined;
        const targetJid = rawRemoteJid || (contact['lid'] as string | undefined) || jid;
        await this.deps.manager.markRead(command.accountId, command.tenantId,
          [{ jid: targetJid, id: message['waMessageId'] as string, fromMe: false }]);
      }
    } catch (error) {
      if (command.operation === 'send' || command.operation === 'forward') {
        const reason = error instanceof Error ? error.message.slice(0, 200) : 'SEND_FAILED';
        await messages.updateOne({ _id: messageId, tenantId, accountId }, {
          $set: { status: 'failed', failureReason: reason, updatedAt: new Date() },
          $push: { statusHistory: { status: 'failed', at: new Date() } }
        });
        await db.collection('conversations').updateOne({ _id: conversation['_id'], tenantId, accountId, lastMessageAt: { $lte: message['timestamp'] as Date } },
          { $set: { lastMessageStatus: 'failed' } });
        await this.publishStatus(command, conversation, 'failed', undefined, reason);
      }
      throw error;
    }
  }

  private async publishStatus(command: OutboundCommand, conversation: Record<string, unknown>,
    status: 'sent' | 'delivered' | 'read' | 'failed', waMessageId?: string, failureReason?: string): Promise<void> {
    await this.deps.publish({
      type: 'message.status', tenantId: command.tenantId, accountId: command.accountId,
      conversationId: conversation['_id']!.toString(), assignedUserId: conversation['assignedUserId']?.toString() ?? null,
      messageId: command.messageId, status, waMessageId, failureReason
    });
  }

  private async publishUpdated(command: OutboundCommand, conversation: Record<string, unknown>): Promise<void> {
    const db = this.deps.connection.db!;
    const record = await db.collection('messages').findOne({
      _id: new Types.ObjectId(command.messageId),
      tenantId: new Types.ObjectId(command.tenantId), accountId: new Types.ObjectId(command.accountId)
    });
    if (!record) return;
    const message: MessageView = {
      _id: command.messageId, tenantId: command.tenantId, accountId: command.accountId,
      conversationId: conversation['_id']!.toString(), contactId: record['contactId']!.toString(),
      waMessageId: record['waMessageId'] as string, clientMessageId: record['clientMessageId'] as string | undefined,
      direction: 'out', type: record['type'] as MessageView['type'], timestamp: (record['timestamp'] as Date).toISOString(),
      status: record['status'] as MessageView['status'], text: record['text'] as string | undefined,
      caption: record['caption'] as string | undefined, mediaId: record['mediaId']?.toString(),
      editedAt: (record['editedAt'] as Date | undefined)?.toISOString(), revokedAt: (record['revokedAt'] as Date | undefined)?.toISOString()
    };
    await this.deps.publish({
      type: 'message.updated', tenantId: command.tenantId, accountId: command.accountId,
      conversationId: conversation['_id']!.toString(), assignedUserId: conversation['assignedUserId']?.toString() ?? null, message
    });
  }

  async status(event: Extract<ProviderEvent, { type: 'wa.message.status' }>): Promise<boolean> {
    const db = this.deps.connection.db!;
    const tenantId = new Types.ObjectId(event.tenantId);
    const accountId = new Types.ObjectId(event.accountId);
    const messages = db.collection<StoredMessage>('messages');
    const record = await messages.findOne({ tenantId, accountId, waMessageId: event.waMessageId });
    if (!record) return false;
    const previous: Record<typeof event.status, MessageView['status'][]> = {
      sent: ['pending', 'failed'], delivered: ['pending', 'sent', 'failed'],
      read: ['pending', 'sent', 'delivered', 'failed'], failed: ['pending', 'sent']
    };
    const updated = await messages.updateOne({ _id: record._id, tenantId, accountId, status: { $in: previous[event.status] } }, {
      $set: { status: event.status, updatedAt: new Date() },
      $push: { statusHistory: { status: event.status, at: new Date() } }
    });
    if (!updated.modifiedCount) return false;
    const conversation = await db.collection('conversations').findOne({ _id: record['conversationId'], tenantId, accountId });
    if (conversation) {
      await db.collection('conversations').updateOne({ _id: conversation['_id'], tenantId, accountId, lastMessageAt: { $lte: record['timestamp'] as Date } },
        { $set: { lastMessageStatus: event.status } });
      await this.publishStatus({
        type: 'outbound', tenantId: event.tenantId, accountId: event.accountId,
        messageId: record._id.toString(), operation: 'send'
      }, conversation, event.status, event.waMessageId);
    }
    return record.direction === 'in' && event.status === 'read';
  }
}
