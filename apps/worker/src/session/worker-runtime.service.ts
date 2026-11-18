import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { TracerService } from '@nestjs/observe';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { type NormalizedInboundMessage, type WorkerCommand, type RefreshAvatarCommand, type RefreshProfileCommand, type ProviderCallEvent, type HistorySyncTarget, type HistorySyncCommand } from '@hala/shared';
import { createStorageRegistry } from '@hala/shared/storage';
import { environmentSchema } from '@hala/shared';
import { BaileysProvider } from '../providers/baileys/baileys.provider.js';
import { CloudApiProvider } from '../providers/cloud-api/cloud-api.provider.js';
import { FakeProvider } from '../providers/fake/fake.provider.js';
import { EncryptedAuthStateStore } from '../providers/baileys/auth-state.store.js';
import { InboundProcessor } from '../inbound/inbound.processor.js';
import { AvatarProcessor } from '../inbound/avatar.processor.js';
import { CallProcessor } from '../inbound/call.processor.js';
import { OutboundProcessor } from '../outbound/outbound.processor.js';
import { LeaseService, RedisLeaseBackend } from './lease.service.js';
import { MongoSessionRepository } from './mongo-session.repository.js';
import { SessionManager } from './session.manager.js';

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly shutdown = new AbortController();
  private redis?: Redis;
  private eventSubscriber?: Redis;
  private commandWorker?: Worker<WorkerCommand>;
  private avatarWorker?: Worker<RefreshAvatarCommand | RefreshProfileCommand>;
  private inboundQueue?: Queue<NormalizedInboundMessage>;
  private inboundWorker?: Worker<NormalizedInboundMessage>;
  private callQueue?: Queue<ProviderCallEvent>;
  private callWorker?: Worker<ProviderCallEvent>;
  private manager?: SessionManager;
  private timer?: NodeJS.Timeout;
  constructor(@Optional() @Inject(TracerService) private readonly tracer?: TracerService) {}

  async onModuleInit(): Promise<void> {
    const env = environmentSchema.parse(process.env);
    const workerId = env.WORKER_ID || randomUUID();
    await mongoose.connect(env.MONGO_URI);
    const mongo = mongoose.connection;
    await mongo.collection('wa_auth_states').createIndex({ accountId: 1, key: 1 }, { unique: true });
    await mongo.collection('whatsapp_accounts').createIndex({ tenantId: 1, desiredState: 1 });
    await mongo.collection('whatsapp_accounts').createIndex({ 'providerConfig.phoneNumberId': 1 }, { unique: true,
      partialFilterExpression: { provider: 'cloud_api', 'providerConfig.phoneNumberId': { $type: 'string' } } });
    await mongo.collection('calls').createIndex({ tenantId: 1, accountId: 1, waCallId: 1 }, { unique: true });
    await mongo.collection('wa_raw_messages').createIndex({ accountId: 1, id: 1 }, { unique: true });
    await mongo.collection('wa_raw_messages').createIndex({ createdAt: 1 }, { expireAfterSeconds: 14 * 86400 });
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.redis = redis;
    await redis.ping();
    const leases = new LeaseService(new RedisLeaseBackend(redis), workerId, env.LEASE_TTL_MS);
    const repository = new MongoSessionRepository(mongo);
    const encryptionKey = process.env.ENCRYPTION_KEY_BASE64 ?? '';
    const provider = new BaileysProvider(new EncryptedAuthStateStore(mongo, leases, encryptionKey), mongo, this.shutdown.signal);
    const cloud = new CloudApiProvider(mongo, encryptionKey, env.CLOUD_GRAPH_VERSION ?? '');
    const storage = createStorageRegistry();
    const processor = new InboundProcessor({ connection: mongo, storage, storageDriver: storage.defaultDriver,
      storageForDriver: driver => storage.forDriver(driver), download: async (source, message) => {
      if (source.cloudMediaId) {
        if (!source.cloudAccountId || !source.cloudTenantId) throw new Error('Cloud media scope missing');
        return cloud.download({ id: source.cloudAccountId, tenantId: source.cloudTenantId }, source);
      }
      if (!message || !provider.downloadMedia) throw new Error('Baileys media message context missing');
      return provider.downloadMedia({ id: message.accountId, tenantId: message.tenantId }, message);
    },
      publish: async event => { await redis.publish('hala.events', JSON.stringify({ event })); } });
    await processor.ensureIndexes();
    this.inboundQueue = new Queue<NormalizedInboundMessage>('wa-inbound', { connection: redis });
    this.inboundWorker = new Worker<NormalizedInboundMessage>('wa-inbound', async job => processor.process(job.data),
      { connection: redis, concurrency: 10 });
    this.inboundWorker.on('completed', job => this.tracer?.summary('hala_inbound_queue_age_ms')?.observe(Date.now() - job.timestamp));
    this.inboundWorker.on('failed', () => this.tracer?.counter('hala_inbound_errors')?.increment());
    const calls = new CallProcessor(mongo, async event => { await redis.publish('hala.events', JSON.stringify({ event })); });
    this.callQueue = new Queue<ProviderCallEvent>('wa-calls', { connection: redis });
    this.callWorker = new Worker<ProviderCallEvent>('wa-calls', async job => calls.process(job.data), { connection: redis, concurrency: 10 });
    this.callWorker.on('failed', () => this.tracer?.counter('hala_call_errors')?.increment());
    const providers = process.env.NODE_ENV === 'test' && process.env.WA_PROVIDER_MODE === 'fake'
      ? [new FakeProvider()] : [provider, cloud];
    this.manager = new SessionManager(leases, repository, providers,
      { publish: async event => {
        if (event.type === 'wa.message.in') {
          if (event.message.history) {
            await processor.process(event.message);
          } else {
            const jobId = createHash('sha256').update(`${event.tenantId}/${event.accountId}/${event.message.waMessageId}`).digest('hex');
            await this.inboundQueue!.add('message', event.message, { jobId, attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true });
          }
        } else if (event.type === 'wa.contact') {
          await processor.syncContact(event);
        } else if (event.type === 'wa.chat.read_state') {
          await processor.syncChatReadState(event);
        } else if (event.type === 'wa.call') {
          await this.callQueue!.add('call', event, { attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true });
        } else if (event.type === 'wa.message.status') {
          const inboundRead = await outbound.status(event);
          if (inboundRead) await processor.syncMessageReadState(event);
        } else if (event.type === 'wa.qr') {
          await redis.set(`hala:qr:${event.accountId}`, event.qr, 'EX', 60);
          await redis.publish('hala.events', JSON.stringify({ event }));
        } else if (event.type === 'wa.connection') {
          if (event.status === 'connected' || event.status === 'logged_out') {
            await redis.del(`hala:qr:${event.accountId}`);
          }
          await redis.publish('hala.events', JSON.stringify({ event }));
        } else {
          await redis.publish('hala.events', JSON.stringify({ event }));
        }
      } }, env.MAX_SESSIONS_PER_WORKER);
    const outbound = new OutboundProcessor({ connection: mongo, storage, storageForDriver: driver => storage.forDriver(driver), manager: this.manager,
      publish: async event => { await redis.publish('hala.events', JSON.stringify({ event })); } });
    const avatars = new AvatarProcessor(mongo, storage, this.manager, async event => {
      await redis.publish('hala.events', JSON.stringify({ event }));
    });
    this.avatarWorker = new Worker<RefreshAvatarCommand | RefreshProfileCommand>(`wa-avatars-${workerId}`,
      async job => job.data.type === 'refresh_profile' ? avatars.processProfile(job.data) : avatars.process(job.data),
      { connection: redis, concurrency: 1, limiter: { max: 1, duration: 700 } });
    this.avatarWorker.on('failed', () => this.tracer?.counter('hala_avatar_errors')?.increment());
    this.commandWorker = new Worker<WorkerCommand>(`wa-commands-${workerId}`, async job => {
      if (job.data.type === 'outbound') await outbound.process(job.data);
      else if (job.data.type === 'sync_history') {
        const targets = await this.historyTargets(job.data);
        await this.manager?.requestHistory(job.data.accountId, job.data.tenantId, targets);
      }
      else if (job.data.type === 'refresh_avatar') await avatars.process(job.data);
      else if (job.data.type === 'refresh_profile') await avatars.processProfile(job.data);
      else await this.manager?.command(job.data);
    }, { connection: redis, concurrency: 10 });
    this.commandWorker.on('failed', () => this.tracer?.counter('hala_outbound_errors')?.increment());
    this.eventSubscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    await this.eventSubscriber.subscribe('hala.events');
    this.eventSubscriber.on('message', (_channel, payload) => {
      try {
        const value = JSON.parse(payload) as { event?: { type?: string; tenantId?: string; accountId?: string; waMessageId?: string; status?: string } };
        const event = value.event;
        if (event?.type === 'wa.message.status' && event.tenantId && event.accountId && event.waMessageId &&
          (event.status === 'sent' || event.status === 'delivered' || event.status === 'read' || event.status === 'failed')) {
          void outbound.status({ type: 'wa.message.status', tenantId: event.tenantId, accountId: event.accountId,
            waMessageId: event.waMessageId, status: event.status }).catch(() => this.tracer?.counter('hala_status_errors')?.increment());
        }
      } catch { this.tracer?.counter('hala_status_errors')?.increment(); }
    });
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1500));
    await this.manager.tick();
    this.timer = setInterval(() => { void this.manager?.tick().then(() => {
      this.tracer?.gauge('hala_active_sessions', { kind: 'additive' })?.setValue(this.manager?.size ?? 0);
      this.tracer?.gauge('hala_average_connection_age_ms', { kind: 'ratio' })?.setValue(this.manager?.averageConnectionAgeMs ?? 0);
    }).catch(error => { this.tracer?.counter('hala_session_errors')?.increment(); this.logger.error('Session reconciliation failed', error instanceof Error ? error.stack : error); }); }, Math.min(10_000, Math.floor(env.LEASE_TTL_MS / 3)));
    this.logger.log(`Worker ${workerId} started`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    await this.commandWorker?.close();
    await this.avatarWorker?.close();
    await this.inboundWorker?.close();
    await this.callWorker?.close();
    await this.callQueue?.close();
    await this.inboundQueue?.close();
    await this.manager?.stop();
    this.eventSubscriber?.disconnect();
    this.redis?.disconnect();
    await mongoose.disconnect();
  }

  private async historyTargets(command: HistorySyncCommand): Promise<HistorySyncTarget[]> {
    const db = mongoose.connection.db;
    if (!db) throw new Error('MONGO_NOT_READY');
    const tenantId = new mongoose.Types.ObjectId(command.tenantId);
    const accountId = new mongoose.Types.ObjectId(command.accountId);
    const conversations = db.collection('conversations').find({
      tenantId, accountId,
      ...(command.conversationId ? { _id: new mongoose.Types.ObjectId(command.conversationId) } : {})
    }, { projection: { contactId: 1 } });
    const targets: HistorySyncTarget[] = [];
    for await (const conversation of conversations) {
      this.shutdown.signal.throwIfAborted();
      const contactId = conversation['contactId'];
      if (!contactId) continue;
      const [contact, anchor] = await Promise.all([
        db.collection('contacts').findOne({ _id: contactId, tenantId }, { projection: { waId: 1, lid: 1 } }),
        db.collection('messages').findOne({ tenantId, accountId, conversationId: conversation._id,
          waMessageId: { $type: 'string', $ne: '' }, timestamp: { $type: 'date' } },
        { sort: { timestamp: -1, _id: -1 }, projection: { waMessageId: 1, raw: 1, direction: 1, timestamp: 1 } })
      ]);
      if (!anchor) continue;
      const contactWaId = contact?.['waId'];
      const raw = anchor['raw'];
      const storedRemoteJid = raw && typeof raw === 'object' && 'remoteJid' in raw && typeof raw['remoteJid'] === 'string'
        ? raw['remoteJid'] : undefined;
      const contactLid = contact?.['lid'];
      const jid = storedRemoteJid ?? (typeof contactLid === 'string' ? contactLid : contactWaId);
      const messageId = anchor['waMessageId'];
      const timestamp = anchor['timestamp'];
      const timestampMs = timestamp instanceof Date ? timestamp.getTime() : Number.NaN;
      if (typeof jid !== 'string' || jid === 'status@broadcast' || typeof messageId !== 'string' ||
        typeof anchor['direction'] !== 'string' || !Number.isFinite(timestampMs) || timestampMs <= 0) continue;
      targets.push({ jid, oldestMessageId: messageId, fromMe: anchor['direction'] === 'out', timestampMs });
    }
    return targets;
  }
}
