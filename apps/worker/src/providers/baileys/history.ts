import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { inflate } from 'node:zlib';
import { downloadHistory, jidNormalizedUser, proto, type BaileysEventMap, type WASocket, type WAMessage } from '@whiskeysockets/baileys';
import { type HistorySyncTarget, type ProviderContact } from '@hala/shared';
import { contactsFromHistoryMappings } from './chat-contact.js';

const inflateHistory = promisify(inflate);
const onDemand = proto.HistorySync.HistorySyncType.ON_DEMAND;

export interface HistoryBatch {
  chats: proto.IConversation[];
  messages: WAMessage[];
  contacts: ProviderContact[];
  syncType?: proto.HistorySync.HistorySyncType | null;
}

export function historyBatchFromPayload(payload: proto.IHistorySync, inline: boolean): HistoryBatch {
  const chats = payload.conversations ?? [];
  const contacts = contactsFromHistoryMappings(payload.phoneNumberToLidMappings ?? []);
  // Baileys 6.7.24 rejects the entire downloaded batch if a message entry has no key.
  const needsFallback = chats.some(chat => chat.messages?.some(item => !item.message?.key));
  const messages: WAMessage[] = [];
  for (const chat of chats) {
    for (const { message } of chat.messages ?? []) {
      if (!message?.key?.id) continue;
      if (!message.key.remoteJid && chat.id) {
        messages.push({ ...message, key: { ...message.key, remoteJid: chat.id } });
      } else if ((inline || needsFallback) && message.key.remoteJid) {
        messages.push({ ...message, key: message.key });
      }
    }
  }
  if (inline || needsFallback) {
    for (const name of payload.pushnames ?? []) {
      if (name.id) contacts.push({ id: name.id, notify: name.pushname ?? undefined });
    }
  }
  return { chats: inline || needsFallback ? chats : [], contacts, messages, syncType: payload.syncType };
}

export async function supplementalHistory(notification: proto.Message.IHistorySyncNotification, signal: AbortSignal): Promise<HistoryBatch> {
  const inline = notification.initialHistBootstrapInlinePayload;
  const payload = inline?.length
    ? proto.HistorySync.decode(await inflateHistory(inline, { maxOutputLength: 128 * 1024 * 1024 }))
    : await downloadHistory(notification, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  return historyBatchFromPayload(payload, Boolean(inline?.length));
}

type HistoryPage = BaileysEventMap['messaging-history.set'];

function olderAnchor(page: HistoryPage, target: HistorySyncTarget): HistorySyncTarget | undefined {
  const jids = historyChatJids(page, target);
  const singleChatId = page.chats.length === 1 ? page.chats[0]?.id : undefined;
  let oldest: HistorySyncTarget | undefined;
  for (const message of page.messages) {
    const jid = message?.key?.remoteJid || singleChatId;
    if (!message?.key?.id || message.key.id === target.oldestMessageId || !jid ||
      !jids.has(jidNormalizedUser(jid))) continue;
    const timestampMs = Number(message.messageTimestamp) * 1000;
    if (!Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs >= target.timestampMs ||
      (oldest && timestampMs >= oldest.timestampMs)) continue;
    oldest = { jid, oldestMessageId: message.key.id, fromMe: Boolean(message.key.fromMe), timestampMs };
  }
  return oldest;
}

function historyChatJids(page: HistoryPage, target: HistorySyncTarget): Set<string> {
  const jid = jidNormalizedUser(target.jid);
  const jids = new Set([jid]);
  for (const chat of page.chats) {
    const aliases = [chat.id, chat.lidJid, chat.pnJid]
      .filter((id): id is string => Boolean(id)).map(id => jidNormalizedUser(id));
    if (aliases.includes(jid)) for (const alias of aliases) jids.add(alias);
  }
  return jids;
}

async function fetchOlderHistoryPage(
  socket: WASocket, target: HistorySyncTarget, signal: AbortSignal
): Promise<HistorySyncTarget | undefined> {
  const jid = jidNormalizedUser(target.jid);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const pending: HistoryPage[] = [];
  let requestId: string | undefined;
  let resolvePage: (page?: HistoryPage) => void;
  const response = new Promise<HistoryPage | undefined>(resolve => { resolvePage = resolve; });
  const onAbort = () => resolvePage();
  const onPage = (page: HistoryPage) => {
    if (page.syncType !== onDemand) return;
    if (!requestId) {
      pending.push(page);
      return;
    }
    const aliases = historyChatJids(page, target);
    if (page.peerDataRequestSessionId === requestId ||
      (!page.peerDataRequestSessionId && (page.chats.some(chat => aliases.has(jidNormalizedUser(chat.id))) ||
        page.messages.some(message => message?.key?.remoteJid && jidNormalizedUser(message.key.remoteJid) === jid)))) {
      resolvePage(page);
    }
  };
  timeout.addEventListener('abort', onAbort, { once: true });
  socket.ev.on('messaging-history.set', onPage);
  try {
    signal.throwIfAborted();
    requestId = await socket.fetchMessageHistory(50, {
      remoteJid: target.jid, id: target.oldestMessageId, fromMe: target.fromMe
    }, target.timestampMs);
    for (const page of pending.splice(0)) onPage(page);
    const page = await response;
    if (!page && !signal.aborted) throw new Error('WhatsApp history response timed out');
    return page ? olderAnchor(page, target) : undefined;
  } finally {
    socket.ev.off('messaging-history.set', onPage);
    timeout.removeEventListener('abort', onAbort);
  }
}

export async function pageHistory(
  socket: WASocket, targets: HistorySyncTarget[], signal: AbortSignal, onFailure: () => void
): Promise<number> {
  let pageTargets = targets;
  let received = 0;
  while (pageTargets.length && !signal.aborted) {
    const next: HistorySyncTarget[] = [];
    for (const target of pageTargets) {
      if (signal.aborted) break;
      try {
        const older = await fetchOlderHistoryPage(socket, target, signal);
        if (!signal.aborted) received++;
        if (older) next.push(older);
      } catch {
        if (!signal.aborted) onFailure();
      }
      if (!signal.aborted) await delay(1500, undefined, { signal }).catch(() => {});
    }
    pageTargets = next;
  }
  return received;
}
