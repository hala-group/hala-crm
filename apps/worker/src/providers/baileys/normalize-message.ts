import { extractMessageContent, getContentType, proto, type WAMessage, type DownloadableMessage } from '@whiskeysockets/baileys';
import { type MediaSource, type NormalizedInboundMessage, type MessageType } from '@hala/shared';

type MediaFields = DownloadableMessage & {
  mimetype?: string | null; fileName?: string | null; fileLength?: number | { toString(): string } | null;
  width?: number | null; height?: number | null; seconds?: number | null;
};

const ignoredTransportStubs = new Set([
  proto.WebMessageInfo.StubType.CIPHERTEXT,
  proto.WebMessageInfo.StubType.E2E_ENCRYPTED,
  proto.WebMessageInfo.StubType.E2E_ENCRYPTED_NOW
]);

function phoneFromJid(jid: string | undefined): string | undefined {
  const match = jid?.match(/^([1-9][0-9]{5,15})@s\.whatsapp\.net$/);
  return match ? `+${match[1]}` : undefined;
}

function mediaSource(kind: MediaSource['kind'], fields: MediaFields | null | undefined): MediaSource | undefined {
  if (!fields?.mediaKey || (!fields.directPath && !fields.url)) return undefined;
  return {
    kind,
    mimeType: fields.mimetype || ({ image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg', document: 'application/octet-stream', sticker: 'image/webp' }[kind]),
    fileName: fields.fileName ?? undefined,
    size: fields.fileLength ? Number(fields.fileLength.toString()) : undefined,
    width: fields.width ?? undefined, height: fields.height ?? undefined,
    durationSec: fields.seconds ?? undefined,
    mediaKeyBase64: Buffer.from(fields.mediaKey).toString('base64'),
    directPath: fields.directPath ?? undefined, url: fields.url ?? undefined
  };
}

function contextOf(content: proto.IMessage): proto.IContextInfo | null | undefined {
  return content.extendedTextMessage?.contextInfo ?? content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ?? content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ?? content.stickerMessage?.contextInfo ??
    content.contactMessage?.contextInfo ?? content.contactsArrayMessage?.contextInfo ??
    content.locationMessage?.contextInfo ?? content.liveLocationMessage?.contextInfo ??
    content.pollCreationMessage?.contextInfo ?? content.pollCreationMessageV2?.contextInfo ??
    content.pollCreationMessageV3?.contextInfo ?? content.buttonsResponseMessage?.contextInfo ??
    content.listResponseMessage?.contextInfo ?? content.interactiveResponseMessage?.contextInfo ??
    content.templateButtonReplyMessage?.contextInfo;
}

function contactCard(contact: proto.Message.IContactMessage): { name: string; phones: string[]; vcard?: string } {
  const vcard = contact.vcard ?? undefined;
  return {
    name: contact.displayName || 'Contact',
    phones: [...(vcard?.matchAll(/TEL[^:]*:([^\r\n]+)/gi) ?? [])].map(match => match[1]!.trim()),
    vcard
  };
}

export function normalizeBaileysMessage(accountId: string, tenantId: string, message: WAMessage): NormalizedInboundMessage | null {
  const remoteJid = message.key.remoteJid ?? undefined;
  const waMessageId = message.key.id ?? undefined;
  if (!remoteJid || !waMessageId) return null;
  if (remoteJid === 'status@broadcast') return null;
  if (typeof message.messageStubType === 'number' && ignoredTransportStubs.has(message.messageStubType)) return null;
  const isGroup = remoteJid.endsWith('@g.us');
  const isLid = remoteJid.endsWith('@lid');
  // senderPn identifies the sender; on outgoing messages that is our own number.
  const pnJid = !isGroup && isLid && !message.key.fromMe ? message.key.senderPn : undefined;
  const waId = pnJid || remoteJid;
  const lid = !isGroup ? (isLid ? remoteJid : message.key.senderLid) : undefined;
  const content = extractMessageContent(message.message) ?? message.message ?? {};
  const messageType = getContentType(content);
  if (messageType === 'placeholderMessage') return null;
  const seconds = Number(message.messageTimestamp?.toString() ?? 0);
  const normalized: NormalizedInboundMessage = {
    accountId, tenantId, waMessageId, waId, lid,
    phoneE164: phoneFromJid(pnJid || remoteJid),
    pushName: message.pushName ?? undefined, isGroup,
    direction: message.key.fromMe ? 'out' : 'in', type: 'unknown',
    timestamp: new Date((seconds > 0 ? seconds : Date.now() / 1000) * 1000),
    raw: { remoteJid, participant: message.key.participant ?? undefined, messageType, stubType: message.messageStubType ?? undefined, protocolType: content.protocolMessage?.type ?? undefined }
  };
  const context = contextOf(content);
  if (context) {
    normalized.quotedWaMessageId = context.stanzaId ?? undefined;
    normalized.mentions = context.mentionedJid ?? undefined;
    normalized.forwarded = context.isForwarded ?? undefined;
  }

  let type: MessageType = 'unknown';
  if (typeof content.conversation === 'string' || content.extendedTextMessage) {
    type = 'text'; normalized.text = content.conversation ?? content.extendedTextMessage?.text ?? undefined;
  } else if (content.imageMessage) {
    type = 'image'; normalized.caption = content.imageMessage.caption ?? undefined;
    normalized.mediaSource = mediaSource('image', content.imageMessage);
  } else if (content.videoMessage || content.ptvMessage) {
    type = 'video'; const video = content.videoMessage ?? content.ptvMessage;
    normalized.caption = video?.caption ?? undefined; normalized.mediaSource = mediaSource('video', video);
  } else if (content.audioMessage) {
    type = content.audioMessage.ptt ? 'voice' : 'audio';
    normalized.mediaSource = mediaSource('audio', content.audioMessage);
  } else if (content.documentMessage) {
    type = 'document'; normalized.caption = content.documentMessage.caption ?? undefined;
    normalized.mediaSource = mediaSource('document', content.documentMessage);
  } else if (content.stickerMessage) {
    type = 'sticker'; normalized.mediaSource = mediaSource('sticker', content.stickerMessage);
  } else if (content.locationMessage || content.liveLocationMessage) {
    type = 'location'; const location = content.locationMessage ?? content.liveLocationMessage;
    normalized.location = { lat: location?.degreesLatitude ?? 0, lng: location?.degreesLongitude ?? 0,
      name: content.locationMessage?.name ?? undefined, address: content.locationMessage?.address ?? undefined };
  } else if (content.contactMessage || content.contactsArrayMessage) {
    type = 'contacts'; const cards = content.contactsArrayMessage?.contacts ?? [content.contactMessage!];
    normalized.contacts = cards.map(contactCard);
  } else if (content.reactionMessage) {
    type = 'reaction'; normalized.reaction = { targetWaMessageId: content.reactionMessage.key?.id ?? '', emoji: content.reactionMessage.text ?? '' };
  } else if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) {
    type = 'poll'; const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
    normalized.poll = { question: poll?.name ?? '', options: (poll?.options ?? []).map((option, index) => ({
      id: option.optionHash || String(index), text: option.optionName ?? ''
    })), selectableCount: poll?.selectableOptionsCount ?? 1 };
  } else if (content.pollUpdateMessage) {
    type = 'poll_vote';
    const vote = content.pollUpdateMessage;
    const targetWaMessageId = vote.pollCreationMessageKey?.id;
    normalized.quotedWaMessageId = targetWaMessageId ?? undefined;
    if (targetWaMessageId) normalized.pollVote = { targetWaMessageId,
      encryptedPayloadBase64: vote.vote?.encPayload ? Buffer.from(vote.vote.encPayload).toString('base64') : undefined,
      encryptedIvBase64: vote.vote?.encIv ? Buffer.from(vote.vote.encIv).toString('base64') : undefined };
  } else if (content.templateMessage) {
    type = 'template';
    const template = content.templateMessage;
    const hydrated = template.hydratedTemplate ?? template.hydratedFourRowTemplate;
    normalized.template = { name: template.templateId ?? hydrated?.templateId ?? undefined,
      body: hydrated?.hydratedContentText ?? hydrated?.hydratedTitleText ?? undefined,
      selectedId: template.hydratedTemplate?.hydratedButtons?.[0]?.quickReplyButton?.id ?? undefined };
  } else if (content.interactiveMessage || content.interactiveResponseMessage || content.buttonsMessage ||
    content.buttonsResponseMessage || content.listMessage || content.listResponseMessage || content.templateButtonReplyMessage) {
    type = 'interactive';
    const interactive = content.interactiveMessage;
    const response = content.interactiveResponseMessage;
    const nativeResponse = response?.nativeFlowResponseMessage;
    const list = content.listMessage;
    const listReply = content.listResponseMessage;
    const buttons = content.buttonsMessage;
    const buttonReply = content.buttonsResponseMessage;
    const templateReply = content.templateButtonReplyMessage;
    normalized.text = response?.body?.text ?? buttonReply?.selectedDisplayText ?? listReply?.title ??
      templateReply?.selectedDisplayText ?? undefined;
    normalized.interactive = {
      kind: buttonReply ? 'button_reply' : listReply ? 'list_reply' : templateReply ? 'template_button_reply' :
        nativeResponse?.name ?? (interactive ? 'interactive' : list ? 'list' : buttons ? 'buttons' : 'interactive'),
      title: interactive?.header?.title ?? list?.title ?? undefined,
      body: interactive?.body?.text ?? list?.description ?? buttons?.text ?? buttons?.contentText ?? undefined,
      footer: interactive?.footer?.text ?? list?.footerText ?? buttons?.footerText ?? undefined,
      buttonText: list?.buttonText ?? undefined,
      selectedId: buttonReply?.selectedButtonId ?? listReply?.singleSelectReply?.selectedRowId ??
        templateReply?.selectedId ?? undefined,
      selectedTitle: buttonReply?.selectedDisplayText ?? listReply?.title ?? templateReply?.selectedDisplayText ?? undefined,
      description: listReply?.description ?? undefined,
      responseJson: nativeResponse?.paramsJson ?? undefined
    };
  } else if (content.protocolMessage || message.messageStubType != null) {
    const protocol = content.protocolMessage;
    const protocolType: unknown = protocol?.type;
    const isHistoryOrInternal =
      protocolType === proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION ||
      protocolType === proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE ||
      protocolType === proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE ||
      protocolType === proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE ||
      protocolType === proto.Message.ProtocolMessage.Type.INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC ||
      protocolType === 'HISTORY_SYNC_NOTIFICATION' ||
      protocolType === 'APP_STATE_SYNC_KEY_SHARE' ||
      protocolType === 'PEER_DATA_OPERATION_REQUEST_MESSAGE' ||
      protocolType === 'PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE' ||
      protocolType === 'INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC';
    if (isHistoryOrInternal) {
      return null;
    }
    const targetWaMessageId = protocol?.key?.id;
    normalized.quotedWaMessageId = targetWaMessageId ?? undefined;
    if (targetWaMessageId && protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
      normalized.mutation = { kind: 'revoke', targetWaMessageId };
    } else if (targetWaMessageId && protocol?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protocol.editedMessage) {
      const edited = extractMessageContent(protocol.editedMessage);
      const text = edited?.conversation ?? edited?.extendedTextMessage?.text;
      if (typeof text === 'string') normalized.mutation = { kind: 'edit', targetWaMessageId, text };
    }
    type = 'system';
    if (message.messageStubType === proto.WebMessageInfo.StubType.CALL_MISSED_VOICE) {
      normalized.text = 'مكالمة صوتية فائتة';
    } else if (message.messageStubType === proto.WebMessageInfo.StubType.CALL_MISSED_VIDEO) {
      normalized.text = 'مكالمة فيديو فائتة';
    } else if (message.messageStubType === proto.WebMessageInfo.StubType.CALL_MISSED_GROUP_VOICE) {
      normalized.text = 'مكالمة جماعية صوتية فائتة';
    } else if (message.messageStubType === proto.WebMessageInfo.StubType.CALL_MISSED_GROUP_VIDEO) {
      normalized.text = 'مكالمة جماعية فيديو فائتة';
    }
  }
  normalized.type = type;
  return normalized;
}
