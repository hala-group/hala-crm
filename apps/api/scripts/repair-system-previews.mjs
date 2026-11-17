import mongoose from 'mongoose';

const uri = process.env.MONGO_URI;
if (!uri) throw new Error('MONGO_URI is required');

const apply = process.argv.includes('--apply');
await mongoose.connect(uri);
try {
  const db = mongoose.connection.db;
  const conversations = db.collection('conversations');
  const messages = db.collection('messages');
  const misclassified = { type: 'system', 'raw.stubType': { $exists: false },
    'raw.protocolType': { $exists: false }, 'raw.messageType': { $exists: true, $ne: 'protocolMessage' } };
  const reclassified = apply
    ? (await messages.updateMany(misclassified, { $set: { type: 'unknown', updatedAt: new Date() } })).modifiedCount
    : await messages.countDocuments(misclassified);
  let scanned = 0;
  let repaired = 0;
  let systemOnly = 0;

  for await (const conversation of conversations.find({ lastMessageType: 'system' },
    { projection: { _id: 1, tenantId: 1, accountId: 1 } })) {
    scanned++;
    const latest = await messages.findOne({
      tenantId: conversation.tenantId, accountId: conversation.accountId,
      conversationId: conversation._id,
      $or: [{ type: { $ne: 'system' } }, misclassified]
    }, { sort: { timestamp: -1, _id: -1 }, projection: { timestamp: 1, text: 1, caption: 1, type: 1, direction: 1 } });
    if (!latest) {
      systemOnly++;
      continue;
    }
    if (apply) {
      const result = await conversations.updateOne({ _id: conversation._id, tenantId: conversation.tenantId,
        accountId: conversation.accountId, lastMessageType: 'system' }, { $set: {
        lastMessageAt: latest.timestamp,
        lastMessagePreview: latest.text?.trim() || latest.caption?.trim() || '',
        lastMessageType: latest.type === 'system' ? 'unknown' : latest.type,
        lastMessageDirection: latest.direction,
        updatedAt: new Date()
      } });
      repaired += result.modifiedCount;
    } else repaired++;
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', reclassified, scanned, repaired, systemOnly }));
} finally {
  await mongoose.disconnect();
}
