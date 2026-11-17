import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Controller, ForbiddenException, Get, OnModuleDestroy, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/mongoose';
import { type Connection, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { type Request } from 'express';
import { cloudWebhookVerifySchema, type NormalizedInboundMessage } from '@hala/shared';
import { Public } from '../../common/public.decorator.js';

export interface CloudMessage {
  id: string; from: string; timestamp: string; type: string;
  text?: { body?: string }; image?: CloudMedia; video?: CloudMedia; audio?: CloudMedia;
  document?: CloudMedia; sticker?: CloudMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji: string };
  context?: { id?: string; message_id?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
    nfm_reply?: { name?: string; response_json?: string } };
  button?: { text?: string; payload?: string };
  template?: { name?: string; language?: string; components?: unknown[] };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
}
interface CloudMedia { id: string; mime_type?: string; caption?: string; filename?: string }
interface CloudContact { wa_id: string; profile?: { name?: string } }
interface CloudPayload { entry?: { changes?: { value?: {
  metadata?: { phone_number_id?: string }; contacts?: CloudContact[];
  messages?: CloudMessage[]; statuses?: { id: string; status: string }[];
} }[] }[] }

export function verifyCloudSignature(rawBody: Buffer | undefined, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !rawBody || !signature?.startsWith('sha256=')) return false;
  const hex = signature.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(hex, 'hex');
  return timingSafeEqual(given, expected);
}

export function normalizeCloudMessage(accountId: string, tenantId: string, message: CloudMessage,
  contacts: CloudContact[] = []): NormalizedInboundMessage {
  const media = (message as unknown as Record<string, CloudMedia | undefined>)[message.type];
  const supported = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'reaction', 'interactive', 'contacts', 'template'];
  const isVoice = message.type === 'audio' && /audio\/ogg(?:\s*;\s*codecs=opus)?/i.test(media?.mime_type ?? '');
  const interactiveReply = message.interactive?.button_reply ?? message.interactive?.list_reply;
  const isButton = message.type === 'button';
  return {
    tenantId, accountId, waMessageId: message.id, waId: `${message.from}@s.whatsapp.net`,
    phoneE164: `+${message.from}`, pushName: contacts.find(contact => contact.wa_id === message.from)?.profile?.name,
    isGroup: false, direction: 'in', type: isVoice ? 'voice' : isButton ? 'interactive'
      : supported.includes(message.type) ? message.type as NormalizedInboundMessage['type'] : 'unknown',
    timestamp: Number.isFinite(Number(message.timestamp)) ? new Date(Number(message.timestamp) * 1000) : new Date(),
    text: message.text?.body ?? interactiveReply?.title ?? message.interactive?.nfm_reply?.response_json ?? message.button?.text,
    caption: media?.caption, quotedWaMessageId: message.context?.message_id ?? message.context?.id,
    contacts: message.contacts?.map(contact => ({ name: contact.name?.formatted_name ?? 'Unknown',
      phones: contact.phones?.flatMap(phone => phone.phone ? [phone.phone] : []) ?? [] })),
    location: message.location ? { lat: message.location.latitude, lng: message.location.longitude,
      name: message.location.name, address: message.location.address } : undefined,
    interactive: message.interactive ? { kind: message.interactive.type ?? 'interactive',
      selectedId: interactiveReply?.id, selectedTitle: interactiveReply?.title,
      description: message.interactive.list_reply?.description,
      responseJson: message.interactive.nfm_reply?.response_json }
      : isButton ? { kind: 'button_reply', selectedId: message.button?.payload, selectedTitle: message.button?.text } : undefined,
    template: message.template ? { name: message.template.name, language: message.template.language,
      componentsJson: message.template.components ? JSON.stringify(message.template.components) : undefined } : undefined,
    reaction: message.reaction ? { targetWaMessageId: message.reaction.message_id, emoji: message.reaction.emoji } : undefined,
    raw: { messageType: message.type },
    mediaSource: media?.id ? { kind: message.type as 'image' | 'video' | 'audio' | 'document' | 'sticker',
      mimeType: media.mime_type ?? 'application/octet-stream', fileName: media.filename,
      cloudMediaId: media.id, cloudAccountId: accountId, cloudTenantId: tenantId } : undefined
  };
}

@ApiTags('cloud webhook')
@Controller('webhooks/whatsapp/cloud')
export class CloudWebhookController implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  private readonly inbound = new Queue<NormalizedInboundMessage>('wa-inbound', { connection: this.redis });
  constructor(@InjectConnection() private readonly db: Connection) { this.redis.on('error', () => {}); }
  async onModuleDestroy(): Promise<void> { await this.inbound.close(); this.redis.disconnect(); }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Verify Meta webhook challenge' })
  verify(@Query({ schema: cloudWebhookVerifySchema }) query: Record<string, string>): string {
    if (query['hub.mode'] !== 'subscribe' || !process.env.CLOUD_WEBHOOK_VERIFY_TOKEN ||
      query['hub.verify_token'] !== process.env.CLOUD_WEBHOOK_VERIFY_TOKEN) throw new ForbiddenException();
    return query['hub.challenge'] ?? '';
  }

  @Post()
  @Public()
  @ApiOperation({ summary: 'Receive signed Cloud API events' })
  async receive(@Req() request: Request & { rawBody?: Buffer }): Promise<{ accepted: true }> {
    const secret = process.env.CLOUD_APP_SECRET;
    const signature = request.header('x-hub-signature-256');
    if (!verifyCloudSignature(request.rawBody, signature, secret)) throw new ForbiddenException();
    const payload = request.body as CloudPayload;
    if (!Array.isArray(payload.entry)) throw new BadRequestException('Invalid webhook payload');
    for (const entry of payload.entry) for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      // Verified Meta webhook is the sole cross-tenant lookup boundary.
      const account = await this.db.collection('whatsapp_accounts').findOne({ provider: 'cloud_api',
        'providerConfig.phoneNumberId': phoneNumberId, desiredState: 'connected' });
      if (!account) continue;
      const tenantId = (account['tenantId'] as Types.ObjectId).toString();
      const accountId = account._id.toString();
      for (const message of value?.messages ?? []) {
        const normalized = normalizeCloudMessage(accountId, tenantId, message, value?.contacts ?? []);
        await this.inbound.add('message', normalized, { jobId: `cloud-${accountId}-${message.id}`, attempts: 5,
          backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true });
      }
      for (const status of value?.statuses ?? []) await this.redis.publish('hala.events', JSON.stringify({ event: {
        type: 'wa.message.status', tenantId, accountId, waMessageId: status.id,
        status: status.status === 'read' ? 'read' : status.status === 'delivered' ? 'delivered' : status.status === 'failed' ? 'failed' : 'sent'
      } }));
    }
    return { accepted: true };
  }
}
