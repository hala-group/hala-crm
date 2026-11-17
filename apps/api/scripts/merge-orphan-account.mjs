import mongoose from 'mongoose';
import { createStorageFromEnv } from '@hala/shared/storage';

const valueAfter = flag => process.argv[process.argv.indexOf(flag) + 1];
const sourceValue = valueAfter('--source');
const targetValue = valueAfter('--target');
if (!mongoose.isValidObjectId(sourceValue) || !mongoose.isValidObjectId(targetValue) || sourceValue === targetValue) {
  throw new Error('Pass distinct --source and --target account ObjectIds');
}
if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');

const sourceId = new mongoose.Types.ObjectId(sourceValue);
const targetId = new mongoose.Types.ObjectId(targetValue);
const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGO_URI);
try {
  const db = mongoose.connection.db;
  const accounts = db.collection('whatsapp_accounts');
  const conversations = db.collection('conversations');
  const messages = db.collection('messages');
  const media = db.collection('media');
  const target = await accounts.findOne({ _id: targetId }, { projection: { tenantId: 1 } });
  if (!target) throw new Error('Target account does not exist');
  if (await accounts.findOne({ _id: sourceId })) throw new Error('Source account still exists; only orphan history can be merged');

  const scope = { tenantId: target.tenantId };
  const oldMessages = await messages.find({ ...scope, accountId: sourceId }).toArray();
  const currentMessages = await messages.find({ ...scope, accountId: targetId },
    { projection: { waMessageId: 1, contactId: 1 } }).toArray();
  if (oldMessages.length !== await messages.countDocuments({ accountId: sourceId })) {
    throw new Error('Source history spans multiple tenants');
  }
  const currentByWaId = new Map(currentMessages.map(message => [message.waMessageId, message]));
  const shared = oldMessages.filter(message => currentByWaId.has(message.waMessageId));
  if (oldMessages.length && (shared.length < 100 || shared.length / oldMessages.length < 0.8)) {
    throw new Error('Insufficient shared WhatsApp message IDs to prove both accounts represent the same number');
  }
  if (shared.some(message => String(message.contactId) !== String(currentByWaId.get(message.waMessageId).contactId))) {
    throw new Error('Shared WhatsApp messages disagree on contact identity');
  }
  const missing = oldMessages.filter(message => message.type !== 'system' && !currentByWaId.has(message.waMessageId));
  if (missing.some(message => message.mediaId)) throw new Error('Missing media require a separate storage-aware merge');
  const oldConversations = await conversations.find({ ...scope, accountId: sourceId }).toArray();
  const oldMedia = await media.find({ ...scope, accountId: sourceId },
    { projection: { storageKey: 1, thumbnailKey: 1 } }).toArray();
  const storagePrefix = `${target.tenantId.toString()}/${sourceId.toString()}/`;
  if (oldMedia.some(asset => typeof asset.storageKey !== 'string' ||
    !asset.storageKey.startsWith(storagePrefix) ||
    (asset.thumbnailKey && !asset.thumbnailKey.startsWith(storagePrefix)))) {
    throw new Error('A source media object has a storage key outside the source account');
  }
  const sourceById = new Map(oldConversations.map(conversation => [String(conversation._id), conversation]));
  if (missing.some(message => !sourceById.has(String(message.conversationId)))) {
    throw new Error('A source message has no matching source conversation');
  }

  let copied = 0;
  let purged = { messages: 0, conversations: 0, media: 0, calls: 0 };
  const touched = new Set();
  if (apply) {
    for (const message of missing) {
      const original = sourceById.get(String(message.conversationId));
      const targetFilter = { ...scope, accountId: targetId, contactId: message.contactId };
      await conversations.updateOne(targetFilter, { $setOnInsert: {
        ...original, _id: new mongoose.Types.ObjectId(), accountId: targetId,
        unreadCount: 0, assignedUserId: null, createdAt: new Date(), updatedAt: new Date()
      } }, { upsert: true });
      const destination = await conversations.findOne(targetFilter, { projection: { _id: 1 } });
      if (!destination) throw new Error('Target conversation missing after upsert');
      const { _id: _sourceMessageId, ...fields } = message;
      try {
        await messages.insertOne({ ...fields, accountId: targetId, conversationId: destination._id,
          createdAt: new Date(), updatedAt: new Date() });
        copied++;
      } catch (error) {
        if (error?.code !== 11000 || !await messages.findOne({ ...scope, accountId: targetId,
          waMessageId: message.waMessageId })) throw error;
      }
      touched.add(String(destination._id));
    }
    for (const id of touched) {
      const latest = await messages.findOne({ ...scope, accountId: targetId,
        conversationId: new mongoose.Types.ObjectId(id), type: { $ne: 'system' } },
      { sort: { timestamp: -1, _id: -1 }, projection: { timestamp: 1, text: 1, caption: 1, type: 1, direction: 1 } });
      if (latest) await conversations.updateOne({ ...scope, _id: new mongoose.Types.ObjectId(id), accountId: targetId },
        { $set: { lastMessageAt: latest.timestamp,
          lastMessagePreview: latest.text?.trim() || latest.caption?.trim() || '',
          lastMessageType: latest.type, lastMessageDirection: latest.direction, updatedAt: new Date() } });
    }
    const targetAfterCopy = new Map((await messages.find({ ...scope, accountId: targetId },
      { projection: { waMessageId: 1, contactId: 1 } }).toArray()).map(message => [message.waMessageId, message]));
    if (oldMessages.some(message => message.type !== 'system' &&
      (String(targetAfterCopy.get(message.waMessageId)?.contactId) !== String(message.contactId)))) {
      throw new Error('A non-system source message is not present under the target account');
    }
    const storage = createStorageFromEnv();
    for (const asset of oldMedia) {
      await storage.delete(asset.storageKey);
      if (asset.thumbnailKey) await storage.delete(asset.thumbnailKey);
    }
    purged = {
      media: (await media.deleteMany({ ...scope, accountId: sourceId })).deletedCount,
      messages: (await messages.deleteMany({ ...scope, accountId: sourceId })).deletedCount,
      conversations: (await conversations.deleteMany({ ...scope, accountId: sourceId })).deletedCount,
      calls: (await db.collection('calls').deleteMany({ ...scope, accountId: sourceId })).deletedCount
    };
    await Promise.all([
      db.collection('history_cursors').deleteMany({ ...scope, accountId: sourceId }),
      db.collection('wa_auth_states').deleteMany({ ...scope, accountId: sourceId }),
      db.collection('whatsapp_account_members').deleteMany({ ...scope, accountId: sourceId })
    ]);
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', sourceMessages: oldMessages.length,
    sharedMessageIds: shared.length, missingVisibleMessages: missing.length,
    copied, sourceConversations: oldConversations.length, sourceMedia: oldMedia.length,
    targetConversationsUpdated: touched.size, purged }));
} finally {
  await mongoose.disconnect();
}
