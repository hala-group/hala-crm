import { randomBytes } from 'node:crypto';
import { Types, type Connection } from 'mongoose';
import sharp from 'sharp';
import { contactDisplayName, type NormalizedInboundMessage, type RefreshAvatarCommand, type RefreshProfileCommand } from '@hala/shared';
import { type StorageRegistry } from '@hala/shared/storage';
import { type SessionManager } from '../session/session.manager.js';

export class AvatarProcessor {
  constructor(private readonly connection: Connection, private readonly storage: StorageRegistry,
    private readonly manager: SessionManager, private readonly publish?: (event: unknown) => Promise<void>) {}

  async processProfile(command: RefreshProfileCommand): Promise<void> {
    const db = this.connection.db;
    if (!db) throw new Error('MONGO_NOT_READY');
    const tenantId = new Types.ObjectId(command.tenantId);
    const accountId = new Types.ObjectId(command.accountId);
    const contactId = new Types.ObjectId(command.contactId);
    const filter = { tenantId, accountId, contactId };
    const [account, contact, conversation] = await Promise.all([
      db.collection('whatsapp_accounts').findOne({ _id: accountId, tenantId }),
      db.collection('contacts').findOne({ _id: contactId, tenantId }),
      db.collection('conversations').findOne(filter, { projection: { _id: 1 } })
    ]);
    if (!account || !contact || !conversation) throw new Error('PROFILE_SCOPE_MISSING');
    const waId = contact['waId'] as string | undefined;
    const phone = (contact['phoneE164'] as string | undefined)?.replace(/\D/g, '');
    const jids = [phone ? `${phone}@s.whatsapp.net` : undefined, waId, contact['lid'] as string | undefined]
      .filter((value): value is string => Boolean(value));
    try {
      const details = jids.length ? await this.manager.fetchContactDetails(command.accountId, command.tenantId, jids) : null;
      if (details?.subject && (contact['isGroup'] || waId?.endsWith('@g.us'))) {
        await db.collection('contacts').updateOne({ tenantId, _id: contactId }, { $set: { displayName: details.subject, isGroup: true, updatedAt: new Date() } });
      }
      await db.collection('conversations').updateOne(filter, { $set: details
        ? { contactAbout: details.about, commonGroups: details.commonGroups, profileStatus: 'ready', profileCheckedAt: new Date() }
        : { contactAbout: null, commonGroups: [], profileStatus: 'unavailable', profileCheckedAt: new Date() } });
      if (this.publish) {
        const refreshedContact = await db.collection('contacts').findOne({ _id: contactId, tenantId });
        const refreshedConversation = await db.collection('conversations').findOne(filter);
        if (refreshedContact && refreshedConversation) {
          await this.publish({
            type: 'conversation.updated',
            tenantId: command.tenantId,
            accountId: command.accountId,
            conversation: {
              _id: refreshedConversation._id.toString(),
              tenantId: command.tenantId,
              accountId: command.accountId,
              contactId: contactId.toString(),
              contactName: contactDisplayName({
                displayName: refreshedContact['displayName'],
                pushName: refreshedContact['pushName'],
                phoneE164: refreshedContact['phoneE164'],
                waId: refreshedContact['waId'] as string,
                isGroup: Boolean(refreshedContact['isGroup'])
              }),
              contactWaId: refreshedContact['waId'] as string,
              ...(refreshedContact['phoneE164'] ? { contactPhoneE164: refreshedContact['phoneE164'] as string } : {}),
              contactAbout: refreshedConversation['contactAbout'] as string | null | undefined,
              commonGroups: (refreshedConversation['commonGroups'] as { id: string; name: string }[] | undefined) ?? [],
              profileStatus: refreshedConversation['profileStatus'] as 'pending' | 'ready' | 'unavailable' | 'failed' | undefined,
              profileCheckedAt: refreshedConversation['profileCheckedAt'] instanceof Date ? (refreshedConversation['profileCheckedAt'] as Date).toISOString() : undefined,
              status: refreshedConversation['status'] as 'open' | 'archived',
              assignedUserId: refreshedConversation['assignedUserId']?.toString() ?? null,
              lastMessageAt: (refreshedConversation['lastMessageAt'] as Date).toISOString(),
              lastMessagePreview: refreshedConversation['lastMessagePreview'] as string,
              lastMessageType: refreshedConversation['lastMessageType'] as NormalizedInboundMessage['type'],
              lastMessageDirection: refreshedConversation['lastMessageDirection'] as 'in' | 'out',
              unreadCount: refreshedConversation['unreadCount'] as number
            }
          });
        }
      }
    } catch (error) {
      await db.collection('conversations').updateOne(filter, { $set: { profileStatus: 'failed', profileCheckedAt: new Date() } });
      throw error;
    }
  }

  async process(command: RefreshAvatarCommand): Promise<void> {
    const db = this.connection.db;
    if (!db) throw new Error('MONGO_NOT_READY');
    const tenantId = new Types.ObjectId(command.tenantId);
    const accountId = new Types.ObjectId(command.accountId);
    const contactId = new Types.ObjectId(command.contactId);
    const filter = { tenantId, accountId, contactId };
    const [account, contact, conversation] = await Promise.all([
      db.collection('whatsapp_accounts').findOne({ _id: accountId, tenantId }),
      db.collection('contacts').findOne({ _id: contactId, tenantId }),
      db.collection('conversations').findOne({ ...filter }, { projection: { _id: 1 } })
    ]);
    const senderMessage = !conversation && await db.collection('messages').findOne({ tenantId, accountId, senderContactId: contactId }, { projection: { _id: 1 } });
    if (!account || !contact || (!conversation && !senderMessage)) throw new Error('AVATAR_SCOPE_MISSING');
    const waId = contact['waId'] as string | undefined;
    const phone = (contact['phoneE164'] as string | undefined)?.replace(/\D/g, '');
    const jid = waId?.endsWith('@s.whatsapp.net') || waId?.endsWith('@g.us') ? waId
      : phone ? `${phone}@s.whatsapp.net` : waId?.endsWith('@lid') ? waId : null;
    const avatars = db.collection('contact_avatars');
    const previous = await avatars.findOne(filter);
    try {
      const picture = jid ? await this.manager.fetchProfilePicture(command.accountId, command.tenantId, jid) : null;
      if (!picture) {
        await avatars.updateOne(filter, { $set: { status: 'unavailable', checkedAt: new Date() },
          $unset: { storageKey: '', storageDriver: '', mimeType: '' } }, { upsert: true });
        if (previous?.['storageKey'] && previous['storageDriver']) {
          await this.storage.forDriver(previous['storageDriver'] as 'local' | 's3' | 'hostinger')
            .delete(previous['storageKey'] as string).catch(() => {});
        }
        return;
      }
      const image = await sharp(picture, { limitInputPixels: 20_000_000 })
        .rotate().resize(160, 160, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
      // The deployed Hostinger endpoint accepts tenant/account/object/original keys.
      const key = `${command.tenantId}/${command.accountId}/${randomBytes(12).toString('hex')}/original`;
      await this.storage.put(key, image, 'image/jpeg');
      try {
        await avatars.updateOne(filter, { $set: { status: 'ready', checkedAt: new Date(), storageKey: key,
          storageDriver: this.storage.defaultDriver, mimeType: 'image/jpeg' } }, { upsert: true });
      } catch (error) {
        await this.storage.delete(key).catch(() => {});
        throw error;
      }
      if (previous?.['storageKey'] && previous['storageDriver']) {
        await this.storage.forDriver(previous['storageDriver'] as 'local' | 's3' | 'hostinger')
          .delete(previous['storageKey'] as string).catch(() => {});
      }
    } catch (error) {
      await avatars.updateOne(filter, { $set: { status: 'failed', checkedAt: new Date() } });
      throw error;
    }
  }
}
