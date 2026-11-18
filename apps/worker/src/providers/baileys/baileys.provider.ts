import makeWASocket, { areJidsSameUser, Browsers, BufferJSON, decryptPollVote, DisconnectReason, extractMessageContent, getHistoryMsg, jidNormalizedUser,
  getKeyAuthor, makeCacheableSignalKeyStore, proto, type AnyMessageContent, type CacheStore, type WASocket, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys';
import { Logger } from '@nestjs/common';
import { type Connection, Types } from 'mongoose';
import { type ProviderAccount, type ProviderCapability, type ProviderEvent, type ProviderSession, type ProviderMessageKey, type ProviderSendRequest, type HistorySyncTarget, type NormalizedInboundMessage, BAILEYS_CAPABILITIES, type WhatsAppProvider } from '@hala/shared';
import { EncryptedAuthStateStore } from './auth-state.store.js';
import { normalizeBaileysMessage } from './normalize-message.js';
import { InitialHistorySync } from './initial-history-sync.js';
import { chatReadStateFromUpdate, contactFromChat } from './chat-contact.js';
import { downloadHistoryBatch, type HistoryBatch, pageHistory } from './history.js';
import { downloadBaileysMedia } from './media-downloader.js';

export class BaileysProvider implements WhatsAppProvider {
  readonly name = 'baileys';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set(BAILEYS_CAPABILITIES);
  private readonly sockets = new Map<string, WASocket>();
  private readonly historySessions = new WeakMap<WASocket, { signal: AbortSignal; replay(): Promise<void> }>();
  private readonly importingHistory = new WeakSet<WASocket>();
  private readonly initialHistory = new InitialHistorySync();
  private readonly polls = new Map<string, { creatorJid: string; secret: Uint8Array; options: { id: string; text: string }[] }>();
  private readonly messageCache = new Map<string, proto.IMessage>();
  private readonly retryCaches = new Map<string, Map<string, unknown>>();
  private readonly logger = new Logger(BaileysProvider.name);
  constructor(
    private readonly auth: EncryptedAuthStateStore,
    private readonly connection?: Connection,
    private readonly shutdown?: AbortSignal
  ) {}

  private cacheKey(accountId: string, id: string): string {
    return `${accountId}:${id}`;
  }

  private cacheMessage(accountId: string, id: string, message: proto.IMessage): void {
    const key = this.cacheKey(accountId, id);
    if (this.messageCache.size >= 2000) {
      const oldestKey = this.messageCache.keys().next().value;
      if (oldestKey) this.messageCache.delete(oldestKey);
    }
    this.messageCache.set(key, message);
  }

  private async saveRawMessageToDb(accountId: string, id: string, message: proto.IMessage): Promise<void> {
    if (!this.connection?.db) return;
    try {
      await this.connection.db.collection('wa_raw_messages').updateOne(
        { accountId: new Types.ObjectId(accountId), id },
        {
          $set: { raw: JSON.stringify(message, BufferJSON.replacer), updatedAt: new Date() },
          $setOnInsert: { accountId: new Types.ObjectId(accountId), id, createdAt: new Date() }
        },
        { upsert: true }
      );
    } catch (error) {
      this.logger.warn(`Failed to persist raw message ${id}: ${(error as Error).message}`);
    }
  }

  async getMessage(accountId: string, id: string): Promise<proto.IMessage | undefined> {
    const cached = this.messageCache.get(this.cacheKey(accountId, id));
    if (cached) return cached;

    if (this.connection?.db) {
      try {
        const doc = await this.connection.db.collection('wa_raw_messages').findOne({
          accountId: new Types.ObjectId(accountId),
          id
        });
        if (doc?.['raw']) {
          const parsed = JSON.parse(doc['raw'] as string, BufferJSON.reviver) as proto.IMessage;
          this.cacheMessage(accountId, id, parsed);
          return parsed;
        }

        const msg = await this.connection.db.collection('messages').findOne({
          accountId: new Types.ObjectId(accountId),
          waMessageId: id
        });
        if (msg) {
          if (msg['text']) {
            const textMsg: proto.IMessage = { conversation: msg['text'] as string };
            this.cacheMessage(accountId, id, textMsg);
            return textMsg;
          }
          if (msg['type'] === 'reaction' && msg['reaction']) {
            const reactionMsg: proto.IMessage = {
              reactionMessage: {
                key: {
                  remoteJid: msg['outbound']?.['to'] as string | undefined,
                  id: msg['reaction']?.['targetWaMessageId'] as string | undefined,
                  fromMe: (msg['reaction']?.['targetFromMe'] ?? false) as boolean
                },
                text: msg['reaction']?.['emoji'] as string | undefined,
                senderTimestampMs: msg['timestamp'] ? new Date(msg['timestamp'] as string).getTime() : undefined
              }
            };
            this.cacheMessage(accountId, id, reactionMsg);
            return reactionMsg;
          }
        }
      } catch (error) {
        this.logger.warn(`Error retrieving message ${id}: ${(error as Error).message}`);
      }
    }

    return undefined;
  }

  private getRetryCache(accountId: string): CacheStore {
    let cache = this.retryCaches.get(accountId);
    if (!cache) {
      cache = new Map<string, unknown>();
      this.retryCaches.set(accountId, cache);
    }
    return {
      get: <T>(key: string): T | undefined => cache.get(key) as T | undefined,
      set: <T>(key: string, value: T): void => { cache.set(key, value); },
      del: (key: string): void => { cache.delete(key); },
      flushAll: (): void => { cache.clear(); }
    };
  }

  async open(account: ProviderAccount, fencingToken: number, emit: (event: ProviderEvent) => Promise<void>): Promise<ProviderSession> {
    const { state, saveCreds } = await this.auth.load(account, fencingToken);
    const syncFullHistory = this.initialHistory.useFullHistory(account.id, Boolean(state.creds.me || state.creds.account));
    if (syncFullHistory) this.logger.log(`Requesting initial WhatsApp history for account ${account.id}`);
    const historySession = new AbortController();
    const signal = this.shutdown ? AbortSignal.any([historySession.signal, this.shutdown]) : historySession.signal;
    let historyDownloads = Promise.resolve();
    let historyWrites = Promise.resolve();
    let credentialsWrite = Promise.resolve();
    const importHistory = (history: HistoryBatch): Promise<void> => {
      historyWrites = historyWrites.then(async () => {
        if (signal.aborted) return;
        await this.processHistoryData(history, account, emit, signal, socket.user?.id);
      }).catch(() => this.logger.error(`WhatsApp history persistence failed for account ${account.id}`));
      return historyWrites;
    };
    const queueHistory = (message: proto.Message.IHistorySyncNotification): Promise<void> => {
      if (!message.initialHistBootstrapInlinePayload?.length && !(message.mediaKey?.length && message.directPath)) return historyDownloads;
      const batch = `type ${message.syncType ?? 'unknown'}, chunk ${message.chunkOrder ?? 'unknown'}`;
      historyDownloads = historyDownloads.then(async () => {
        if (signal.aborted) return;
        this.logger.log(`Reading WhatsApp history for account ${account.id}, ${batch}`);
        const history = await downloadHistoryBatch(message, signal);
        this.logger.log(`Decoded WhatsApp history for account ${account.id}, ${batch}: ${history.chats.length} chats, ${history.messages.length} messages`);
        await importHistory(history);
      }).catch(error => {
        if (signal.aborted) return;
        const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
        const reason = typeof status === 'number' ? `HTTP ${status}`
          : error instanceof Error && ['AbortError', 'CanceledError', 'TimeoutError'].includes(error.name)
            ? 'download timed out' : 'download or decode failed';
        this.logger.warn(`WhatsApp history for account ${account.id}, ${batch}: ${reason}`);
      });
      return historyDownloads;
    };
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined)
      },
      browser: Browsers.ubuntu('Hala CRM'),
      printQRInTerminal: false,
      syncFullHistory,
      msgRetryCounterCache: this.getRetryCache(account.id),
      getMessage: async (key: proto.IMessageKey) => {
        if (!key.id) return undefined;
        return this.getMessage(account.id, key.id);
      },
      shouldSyncHistoryMessage: message => {
        void queueHistory(message);
        return true;
      }
    });
    this.sockets.set(account.id, socket);
    this.historySessions.set(socket, { signal, replay: async () => {
      const acceptedIds = (state.creds.processedHistoryMessages ?? []).flatMap(({ key }) => key.id ? [key.id] : []);
      await this.replayAcceptedHistory(account, acceptedIds, signal, queueHistory);
      await historyWrites;
    } });
    const notify = (event: ProviderEvent): void => { void emit(event).catch(() => this.logger.warn('Session event rejected')); };
    const publishContact = (contact: { id?: string; lid?: string; jid?: string; name?: string; notify?: string }): void => {
      if (contact.id) notify({ type: 'wa.contact', accountId: account.id, tenantId: account.tenantId,
        contact: { id: contact.id, lid: contact.lid, jid: contact.jid, name: contact.name, notify: contact.notify } });
    };
    socket.ev.on('creds.update', () => {
      credentialsWrite = credentialsWrite.then(saveCreds).catch(() => this.logger.warn('Credential write rejected'));
    });
    socket.ev.on('connection.update', update => {
      if (update.qr) {
        this.logger.log(`WhatsApp QR code generated for account ${account.id}`);
        notify({ type: 'wa.qr', accountId: account.id, tenantId: account.tenantId, qr: update.qr });
      }
      if (update.connection === 'open') {
        notify({ type: 'wa.connection', accountId: account.id, tenantId: account.tenantId, status: 'connected', phoneNumber: socket.user?.id });
        void (async () => {
          try {
            const participating = await socket.groupFetchAllParticipating();
            for (const group of Object.values(participating)) {
              if (group.id && group.subject) {
                publishContact({ id: group.id, name: group.subject });
              }
            }
          } catch {
            this.logger.warn('Failed to fetch participating groups on connect');
          }
        })();
      }
      if (update.connection === 'close') {
        historySession.abort();
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        this.logger.log(`WhatsApp connection closed for account ${account.id} with status code ${code}`);
        if (code === DisconnectReason.loggedOut) {
          this.initialHistory.clear(account.id);
          notify({ type: 'wa.connection', accountId: account.id, tenantId: account.tenantId, status: 'logged_out' });
        } else {
          notify({ type: 'wa.connection', accountId: account.id, tenantId: account.tenantId, status: 'disconnected' });
        }
      }
    });
    socket.ev.on('messages.upsert', update => {
      for (const message of update.messages) {
        if (message.key.id && message.message) {
          this.cacheMessage(account.id, message.key.id, message.message);
          void this.saveRawMessageToDb(account.id, message.key.id, message.message);
        }
      }
      for (const message of update.messages) this.rememberPoll(account.id, message, socket.user?.id);
      for (const message of update.messages) {
        try {
          const normalized = this.normalizeMessage(account.id, account.tenantId, message, socket.user?.id);
          if (normalized) notify({ type: 'wa.message.in', accountId: account.id, tenantId: account.tenantId, message: normalized });
        } catch {
          this.logger.error('Message normalization failed');
        }
      }
    });
    socket.ev.on('messaging-history.set', importHistory);
    socket.ev.on('contacts.upsert', contacts => { for (const contact of contacts) publishContact(contact); });
    socket.ev.on('contacts.update', contacts => { for (const contact of contacts) publishContact(contact); });
    socket.ev.on('groups.upsert', groups => {
      for (const group of groups) {
        if (group.id && group.subject) {
          publishContact({ id: group.id, name: group.subject });
        }
      }
    });
    socket.ev.on('groups.update', updates => {
      for (const group of updates) {
        if (group.id && group.subject) {
          publishContact({ id: group.id, name: group.subject });
        }
      }
    });
    socket.ev.on('chats.upsert', chats => {
      for (const chat of chats) {
        const contact = contactFromChat(chat);
        if (contact) publishContact(contact);
        const readState = chatReadStateFromUpdate(chat);
        if (readState) {
          notify({ type: 'wa.chat.read_state', accountId: account.id, tenantId: account.tenantId,
            ...readState });
        }
      }
    });
    socket.ev.on('chats.update', chats => {
      for (const chat of chats) {
        const contact = contactFromChat(chat);
        if (contact) publishContact(contact);
        const readState = chatReadStateFromUpdate(chat);
        if (readState) {
          notify({ type: 'wa.chat.read_state', accountId: account.id, tenantId: account.tenantId,
            ...readState });
        }
      }
    });
    socket.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
      publishContact({ id: lid, lid, jid });
    });
    socket.ev.on('messages.update', updates => {
      for (const item of updates) {
        if (!item.key.id || item.update.status == null) continue;
        if (item.update.status === proto.WebMessageInfo.Status.PENDING) continue;
        const status = item.update.status >= proto.WebMessageInfo.Status.READ ? 'read'
          : item.update.status >= proto.WebMessageInfo.Status.DELIVERY_ACK ? 'delivered'
          : item.update.status >= proto.WebMessageInfo.Status.SERVER_ACK ? 'sent' : 'failed';
        notify({ type: 'wa.message.status', accountId: account.id, tenantId: account.tenantId, waMessageId: item.key.id, status });
      }
    });
    socket.ev.on('message-receipt.update', updates => {
      for (const item of updates) {
        if (!item.key.id) continue;
        const status = item.receipt.readTimestamp || item.receipt.playedTimestamp ? 'read'
          : item.receipt.receiptTimestamp ? 'delivered' : null;
        if (status) notify({ type: 'wa.message.status', accountId: account.id, tenantId: account.tenantId,
          waMessageId: item.key.id, status });
      }
    });
    socket.ev.on('call', calls => {
      for (const call of calls) {
        const status = call.status === 'offer' || call.status === 'ringing' ? 'ringing'
          : call.status === 'timeout' ? 'missed' : call.status === 'reject' ? 'rejected'
          : call.status === 'accept' ? 'accepted' : 'ended';
        notify({ type: 'wa.call', tenantId: account.tenantId, accountId: account.id,
          waCallId: call.id, waId: jidNormalizedUser(call.chatId), direction: areJidsSameUser(call.from, socket.user?.id) ? 'out' : 'in',
          isVideo: Boolean(call.isVideo), status, startedAt: call.date.toISOString() });
      }
    });
    return { close: async () => {
      historySession.abort();
      if (this.sockets.get(account.id) === socket) this.sockets.delete(account.id);
      this.clearPolls(account.id);
      this.retryCaches.delete(account.id);
      socket.end(undefined);
      await Promise.all([credentialsWrite, historyDownloads]);
      await historyWrites;
    } };
  }

  private async replayAcceptedHistory(
    account: ProviderAccount, acceptedIds: string[], signal: AbortSignal,
    queueHistory: (notification: proto.Message.IHistorySyncNotification) => Promise<void>
  ): Promise<void> {
    const db = this.connection?.db;
    if (!db || !acceptedIds.length || signal.aborted) return;
    const accountId = new Types.ObjectId(account.id);
    const tenantId = new Types.ObjectId(account.tenantId);
    if (!await db.collection('whatsapp_accounts').findOne({ _id: accountId, tenantId }, { projection: { _id: 1 } })) return;
    const records = db.collection('wa_raw_messages').find({ accountId, id: { $in: acceptedIds },
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60_000) } }, { projection: { raw: 1 } }).sort({ createdAt: 1, _id: 1 });
    for await (const record of records) {
      if (signal.aborted) return;
      if (typeof record['raw'] !== 'string') continue;
      try {
        const message = JSON.parse(record['raw'], BufferJSON.reviver) as proto.IMessage;
        const notification = getHistoryMsg(message);
        if (notification) await queueHistory(notification);
      } catch {
        this.logger.warn(`Unable to replay cached WhatsApp history for account ${account.id}`);
      }
    }
  }

  async logout(account: ProviderAccount): Promise<void> {
    this.initialHistory.clear(account.id);
    this.clearPolls(account.id);
    this.retryCaches.delete(account.id);
    await this.sockets.get(account.id)?.logout();
  }

  private pollKey(accountId: string, jid: string, messageId: string): string {
    return `${accountId}:${jid}:${messageId}`;
  }

  private rememberPoll(accountId: string, message: WAMessage, ownJid?: string): void {
    const jid = message.key.remoteJid;
    const id = message.key.id;
    if (!jid || !id) return;
    const content = extractMessageContent(message.message) ?? message.message;
    if (!content) return;
    const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
    if (!poll) return;
    const secret = content.messageContextInfo?.messageSecret ?? poll.encKey;
    if (!secret?.length) return;
    this.polls.set(this.pollKey(accountId, jid, id), {
      creatorJid: getKeyAuthor(message.key, ownJid), secret,
      options: (poll.options ?? []).flatMap((option, index) => option.optionName
        ? [{ id: option.optionHash || String(index), text: option.optionName }] : [])
    });
  }

  private normalizeMessage(accountId: string, tenantId: string, message: WAMessage, ownJid?: string) {
    const normalized = normalizeBaileysMessage(accountId, tenantId, message, ownJid);
    const content = extractMessageContent(message.message) ?? message.message;
    const update = content?.pollUpdateMessage;
    const pollId = update?.pollCreationMessageKey?.id;
    const pollJid = update?.pollCreationMessageKey?.remoteJid ?? message.key.remoteJid;
    if (!normalized?.pollVote || !update?.vote || !pollId || !pollJid) return normalized;
    const poll = this.polls.get(this.pollKey(accountId, pollJid, pollId));
    if (!poll) return normalized;
    try {
      const decrypted = decryptPollVote(update.vote, { pollCreatorJid: poll.creatorJid, pollMsgId: pollId,
        pollEncKey: poll.secret, voterJid: getKeyAuthor(message.key, ownJid) });
      const selectedHashes = (decrypted.selectedOptions ?? []).map(value => Buffer.from(value).toString('base64'));
      const selectedOptions = selectedHashes.flatMap(hash => {
        const bytes = Buffer.from(hash, 'base64');
        const variants = new Set([hash, bytes.toString('base64url'), bytes.toString('hex'), bytes.toString('utf8')]);
        const label = poll.options.find(option => variants.has(option.id))?.text;
        return label ? [label] : [];
      });
      normalized.pollVote = { targetWaMessageId: pollId, selectedOptions, selectedOptionHashes: selectedHashes };
      delete normalized.pollVote.encryptedPayloadBase64;
      delete normalized.pollVote.encryptedIvBase64;
    } catch {
      this.logger.warn(`Unable to decrypt poll vote for account ${accountId}`);
    }
    return normalized;
  }

  private clearPolls(accountId: string): void {
    for (const key of this.polls.keys()) if (key.startsWith(`${accountId}:`)) this.polls.delete(key);
  }

  private async processHistoryData(
    history: HistoryBatch,
    account: ProviderAccount,
    emit: (event: ProviderEvent) => Promise<void>,
    signal: AbortSignal,
    ownJid?: string
  ): Promise<void> {
    if (!history.chats.length && !history.contacts.length && !history.messages.length) return;
    const { id: accountId, tenantId } = account;
    let failed = 0;
    let processed = 0;
    const publish = async (event: ProviderEvent): Promise<boolean> => {
      if (signal.aborted) return false;
      try {
        await emit(event);
        return true;
      } catch {
        failed++;
        return false;
      }
    };
    for (const contact of history.contacts) {
      if (signal.aborted) return;
      if (contact.id) await publish({ type: 'wa.contact', accountId, tenantId, contact });
    }
    for (const chat of history.chats) {
      if (signal.aborted) return;
      const contact = contactFromChat(chat);
      if (!contact) continue;
      const timestampMs = Number(chat.conversationTimestamp ?? chat.lastMsgTimestamp) * 1000;
      const historyChat = history.syncType !== proto.HistorySync.HistorySyncType.ON_DEMAND
        ? { timestamp: new Date(Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : 0),
          unreadCount: Math.max(chat.unreadCount ?? 0, 0) }
        : undefined;
      await publish({ type: 'wa.contact', accountId, tenantId, contact, historyChat });
    }
    for (const message of history.messages) {
      if (message?.key?.id) this.rememberPoll(accountId, message, ownJid);
    }
    for (const message of history.messages) {
      if (signal.aborted) return;
      if (!message?.key?.id) continue;
      try {
        const normalized = this.normalizeMessage(accountId, tenantId, message, ownJid);
        if (!normalized) continue;
        if (message.message) {
          this.cacheMessage(accountId, message.key.id, message.message);
          await this.saveRawMessageToDb(accountId, message.key.id, message.message);
        }
        if (await publish({ type: 'wa.message.in', accountId, tenantId, message: { ...normalized, history: true } })) {
          processed++;
          if (processed === 1 || processed % 250 === 0) {
            this.logger.log(`WhatsApp history progress for account ${accountId}: ${processed}/${history.messages.length} messages processed`);
          }
        }
      } catch {
        failed++;
      }
    }
    this.initialHistory.historyReceived(accountId, history.messages.length);
    this.logger.log(`WhatsApp history batch for account ${accountId}: ${history.chats.length} chats, ${processed}/${history.messages.length} messages processed, ${failed} failed events`);
  }

  async syncHistory(account: ProviderAccount, targets: HistorySyncTarget[]): Promise<number> {
    const socket = this.socket(account);
    const session = this.historySessions.get(socket);
    if (!session || session.signal.aborted) throw new Error('ACCOUNT_NOT_RUNNING');
    const { signal } = session;
    if (this.importingHistory.has(socket)) return 0;
    this.importingHistory.add(socket);
    try {
      await session.replay();
      this.logger.log(`Requesting older WhatsApp history for ${targets.length} conversations`);
      let failed = 0;
      const received = await pageHistory(socket, targets, signal, () => { failed++; });
      this.logger.log(`WhatsApp history for account ${account.id}: ${received} page responses, ${failed} failed requests`);
      return received;
    } finally {
      this.importingHistory.delete(socket);
    }
  }

  async downloadMedia(account: ProviderAccount, inbound: NormalizedInboundMessage): Promise<Buffer> {
    const source = inbound.mediaSource;
    if (!source) throw new Error('Media source missing');
    return downloadBaileysMedia(source, async () => {
      const media = {
        mediaKey: Buffer.from(source.mediaKeyBase64 ?? '', 'base64'),
        directPath: source.directPath,
        url: source.url
      };
      const message: WAMessage = {
        key: { remoteJid: inbound.raw?.remoteJid ?? inbound.waId,
          id: inbound.waMessageId, fromMe: inbound.direction === 'out' },
        message: source.kind === 'image' ? { imageMessage: media }
          : source.kind === 'video' ? { videoMessage: media }
          : source.kind === 'audio' ? { audioMessage: media }
          : source.kind === 'document' ? { documentMessage: media }
          : { stickerMessage: media }
      };
      const updated = await this.socket(account).updateMediaMessage(message);
      const refreshed = extractMessageContent(updated.message) ?? updated.message;
      const details = refreshed?.imageMessage ?? refreshed?.videoMessage ?? refreshed?.audioMessage ??
        refreshed?.documentMessage ?? refreshed?.stickerMessage;
      if (!details?.directPath && !details?.url) throw new Error('WhatsApp did not return a refreshed media path');
      return { ...source, directPath: details.directPath ?? undefined, url: details.url ?? undefined };
    }, this.shutdown);
  }

  private socket(account: ProviderAccount): WASocket {
    const socket = this.sockets.get(account.id);
    if (!socket) throw new Error('ACCOUNT_NOT_RUNNING');
    return socket;
  }

  async fetchProfilePicture(account: ProviderAccount, jid: string): Promise<Buffer | null> {
    let url: string | undefined;
    try { url = await this.socket(account).profilePictureUrl(jid, 'preview', 8000); }
    catch (error) {
      const code = (error as { output?: { statusCode?: number } })?.output?.statusCode;
      if (code === 404 || code === 401 || code === 403) return null;
      throw error;
    }
    if (!url) return null;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/(^|\.)(whatsapp\.net|fbcdn\.net)$/.test(parsed.hostname)) {
      throw new Error('Unexpected profile picture host');
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 2_000_000) throw new Error('Profile picture download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2_000_000) throw new Error('Profile picture too large');
    return bytes;
  }

  async fetchContactDetails(account: ProviderAccount, jids: string[]): Promise<{ about: string | null; commonGroups: { id: string; name: string }[]; subject?: string | null }> {
    const socket = this.socket(account);
    const identity = jids.filter(Boolean);
    const isGroup = identity[0]?.endsWith('@g.us');
    if (isGroup) {
      try {
        const metadata = await socket.groupMetadata(identity[0]!);
        return { about: metadata.desc ?? null, commonGroups: [], subject: metadata.subject ?? null };
      } catch {
        return { about: null, commonGroups: [], subject: null };
      }
    }
    const [statuses, groups] = await Promise.all([
      socket.fetchStatus(identity[0]!).catch(() => undefined),
      socket.groupFetchAllParticipating().catch(() => ({}))
    ]);
    const status = statuses?.find(item => identity.some(jid => areJidsSameUser(item.id, jid)))?.status;
    const about = status && typeof status === 'object' && 'status' in status && typeof status.status === 'string'
      ? status.status : null;
    const commonGroups = Object.values(groups).filter(group => group.participants.some(participant =>
      identity.some(jid => [participant.id, participant.jid, participant.lid].some(value =>
        value && areJidsSameUser(value, jid))))).map(group => ({ id: group.id, name: group.subject }));
    return { about, commonGroups };
  }

  private key(key: ProviderMessageKey): WAMessageKey {
    return { remoteJid: key.jid, id: key.id, fromMe: key.fromMe, participant: key.participant };
  }

  async send(account: ProviderAccount, request: ProviderSendRequest): Promise<string> {
    const { input } = request;
    const bytes = request.media ? Buffer.from(request.media) : undefined;
    const forwardedContext = request.forwarded ? { isForwarded: true, forwardingScore: 1 } : undefined;
    let content: AnyMessageContent;
    switch (input.type) {
      case 'text': content = { text: input.text, mentions: input.mentions, contextInfo: forwardedContext }; break;
      case 'image': if (!bytes) throw new Error('MEDIA_MISSING'); content = { image: bytes, mimetype: request.mimeType ?? 'image/jpeg', caption: input.caption, viewOnce: input.viewOnce,
        mentions: input.mentions, contextInfo: forwardedContext }; break;
      case 'video': if (!bytes) throw new Error('MEDIA_MISSING'); content = { video: bytes, mimetype: request.mimeType ?? 'video/mp4', caption: input.caption, gifPlayback: input.gif,
        viewOnce: input.viewOnce, mentions: input.mentions, contextInfo: forwardedContext }; break;
      case 'audio': if (!bytes) throw new Error('MEDIA_MISSING'); content = { audio: bytes, mimetype: request.mimeType ?? 'audio/mpeg', ptt: false }; break;
      case 'voice': {
        if (!bytes) throw new Error('MEDIA_MISSING');
        const waveform = this.extractWaveform(bytes);
        content = { audio: bytes, mimetype: 'audio/ogg; codecs=opus', ptt: true, waveform } as unknown as AnyMessageContent;
        break;
      }
      case 'document': if (!bytes) throw new Error('MEDIA_MISSING'); content = { document: bytes, mimetype: request.mimeType ?? 'application/octet-stream',
        fileName: input.fileName ?? request.fileName, caption: input.caption, contextInfo: forwardedContext }; break;
      case 'sticker': if (!bytes) throw new Error('MEDIA_MISSING'); content = { sticker: bytes, mimetype: 'image/webp' }; break;
      case 'location': content = { location: { degreesLatitude: input.lat, degreesLongitude: input.lng, name: input.name, address: input.address } }; break;
      case 'contacts': content = { contacts: { displayName: input.contacts[0]?.name, contacts: input.contacts.map(card => ({
        displayName: card.name, vcard: card.vcard ?? `BEGIN:VCARD\nVERSION:3.0\nFN:${card.name}\n${card.phones.map(phone => `TEL:${phone}`).join('\n')}\nEND:VCARD`
      })) } }; break;
      case 'reaction': if (!request.target) throw new Error('TARGET_MISSING'); content = { react: { key: this.key(request.target), text: input.emoji } }; break;
      case 'poll': content = { poll: { name: input.question, values: input.options, selectableCount: input.selectableCount }, mentions: input.mentions,
        contextInfo: forwardedContext }; break;
      default: throw new Error('UNSUPPORTED_BY_PROVIDER');
    }
    const quoted = request.quoted ? { key: this.key(request.quoted), message: { conversation: request.quotedText ?? '' } } as WAMessage : undefined;
    const messageId = request.messageId?.startsWith('3EB0') ? request.messageId : undefined;
    const destinationJid = request.jid;
    const sent = await this.socket(account).sendMessage(destinationJid, content, { messageId, quoted });
    if (!sent?.key.id) throw new Error('WA_SEND_NO_ID');
    if (sent.message) {
      this.cacheMessage(account.id, sent.key.id, sent.message);
      void this.saveRawMessageToDb(account.id, sent.key.id, sent.message);
    }
    return sent.key.id;
  }

  async edit(account: ProviderAccount, jid: string, key: ProviderMessageKey, text: string): Promise<void> {
    await this.socket(account).sendMessage(jid, { text, edit: this.key(key) });
  }

  async revoke(account: ProviderAccount, jid: string, key: ProviderMessageKey): Promise<void> {
    await this.socket(account).sendMessage(jid, { delete: this.key(key) });
  }

  private extractWaveform(buffer: Uint8Array): Uint8Array {
    const packetSizes: number[] = [];
    let pos = 0;
    while (pos < buffer.length - 27) {
      if (buffer[pos] === 0x4f && buffer[pos + 1] === 0x67 && buffer[pos + 2] === 0x67 && buffer[pos + 3] === 0x53) {
        const pageSegments = buffer[pos + 26] ?? 0;
        let segTablePos = pos + 27;
        let packetSize = 0;
        for (let i = 0; i < pageSegments && segTablePos < buffer.length; i++) {
          const segLen = buffer[segTablePos++] ?? 0;
          packetSize += segLen;
          if (segLen < 255) {
            if (packetSize > 0) packetSizes.push(packetSize);
            packetSize = 0;
          }
        }
        pos = segTablePos;
      } else {
        pos++;
      }
    }

    const samples = 64;
    const waveform = new Uint8Array(samples);
    if (packetSizes.length >= 2) {
      const step = packetSizes.length / samples;
      const max = Math.max(...packetSizes, 1);
      for (let i = 0; i < samples; i++) {
        const idx = Math.min(packetSizes.length - 1, Math.floor(i * step));
        const val = packetSizes[idx] ?? 0;
        waveform[i] = Math.min(100, Math.max(5, Math.round((val / max) * 95 + 5)));
      }
    } else {
      for (let i = 0; i < samples; i++) {
        waveform[i] = Math.round(20 + 35 * Math.sin((i / samples) * Math.PI));
      }
    }
    return waveform;
  }

  async markRead(account: ProviderAccount, keys: ProviderMessageKey[]): Promise<void> {
    await this.socket(account).readMessages(keys.map(key => this.key(key)));
  }
}
