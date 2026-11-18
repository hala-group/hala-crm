import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { Types, type Model } from 'mongoose';
import { z } from 'zod';
import {
  contactDisplayName,
  defineAbilityFor,
  isPermission,
  type MessageView,
  type DomainEvent,
} from '@hala/shared';
import { createStorageRegistry } from '@hala/shared/storage';
import { runInTenant } from '../../common/tenant-context.js';
import { AccountAccessService } from '../access/account-access.service.js';
import { AccountCommandService } from '../whatsapp-accounts/account-command.service.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import {
  type ContactRecord,
  type ContactAvatarRecord,
  type ConversationRecord,
  type MessageRecord,
} from '../inbox/inbox.schema.js';

const claimsSchema = z.object({
  tenantId: z.string().regex(/^[a-f0-9]{24}$/),
  userId: z.string().regex(/^[a-f0-9]{24}$/),
  accountId: z.string().regex(/^[a-f0-9]{24}$/),
  conversationId: z.string().regex(/^[a-f0-9]{24}$/),
  contactId: z.string().regex(/^[a-f0-9]{24}$/),
  expires: z.number(),
});
type AvatarClaims = z.infer<typeof claimsSchema>;

export function signPushAvatar(claims: AvatarClaims, key: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function verifyPushAvatar(token: string, key: string): AvatarClaims {
  if (token.length > 1500) throw new NotFoundException();
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra || !key) throw new NotFoundException();
  const expected = createHmac('sha256', key).update(body).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw new NotFoundException();
  try {
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (claims.expires <= Date.now()) throw new Error('Expired');
    return claims;
  } catch {
    throw new NotFoundException();
  }
}

function shorten(value: string, limit: number): string {
  const characters = Array.from(value.replace(/[\r\n\t]+/g, ' ').trim());
  return characters.length > limit
    ? `${characters.slice(0, limit).join('')}…`
    : characters.join('');
}

export function pushMessagePreview(message: MessageView): string {
  if (message.revokedAt) return 'تم حذف الرسالة';
  const content =
    message.text ||
    message.caption ||
    message.reaction?.emoji ||
    message.interactive?.selectedTitle ||
    message.interactive?.body ||
    message.template?.body ||
    message.poll?.question ||
    message.location?.name ||
    message.contacts?.map((contact) => contact.name).join('، ');
  if (content?.trim()) return shorten(content, 200);
  const labels: Partial<Record<MessageView['type'], string>> = {
    image: 'صورة',
    video: 'فيديو',
    audio: 'ملف صوتي',
    voice: 'رسالة صوتية',
    document: 'مستند',
    sticker: 'ملصق',
    location: 'موقع',
    contacts: 'جهة اتصال',
    poll: 'استطلاع',
    poll_vote: 'تصويت',
    interactive: 'رسالة تفاعلية',
    template: 'رسالة نموذجية',
  };
  return labels[message.type] ?? 'رسالة';
}

@Injectable()
export class MessagePushContentService {
  private readonly logger = new Logger(MessagePushContentService.name);
  private readonly storage = createStorageRegistry();
  constructor(
    @InjectModel('Contact') private readonly contacts: Model<ContactRecord>,
    @InjectModel('ContactAvatar') private readonly avatars: Model<ContactAvatarRecord>,
    @InjectModel('Conversation') private readonly conversations: Model<ConversationRecord>,
    @InjectModel('Message') private readonly messages: Model<MessageRecord>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @InjectModel('WhatsAppAccount') private readonly accounts: Model<WhatsAppAccountRecord>,
    @Inject(AccountAccessService) private readonly access: AccountAccessService,
    @Inject(AccountCommandService) private readonly commands: AccountCommandService,
  ) {}

  async describe(event: Extract<DomainEvent, { type: 'message.created' }>, contactId: string) {
    const contact = await this.contacts
      .findOne({ tenantId: event.tenantId, _id: contactId })
      .lean();
    const group = Boolean(contact?.isGroup);
    const senderId = group ? event.message.sender?.contactId : contactId;
    const sender = group
      ? senderId
        ? await this.contacts.findOne({ tenantId: event.tenantId, _id: senderId }).lean()
        : null
      : contact;
    const senderName = sender
      ? contactDisplayName(sender)
      : event.message.sender?.name ||
        (event.message.sender ? contactDisplayName(event.message.sender) : 'مرسل غير معروف');
    const title = group
      ? `${shorten(senderName, 48)} · ${shorten(contactDisplayName(contact ?? { isGroup: true }), 42)}`
      : shorten(senderName, 96);
    if (senderId)
      try {
        // Fetch missing sender photos through the existing owning worker, without delaying message delivery.
        const avatar = await this.avatars
          .findOne({ tenantId: event.tenantId, accountId: event.accountId, contactId: senderId })
          .lean();
        const wait =
          avatar?.status === 'ready'
            ? 7 * 86400000
            : avatar?.status === 'pending'
              ? 120000
              : 300000;
        if (!avatar || Date.now() - avatar.checkedAt.getTime() > wait) {
          await this.avatars.updateOne(
            { accountId: event.accountId, contactId: senderId },
            {
              $set: { status: 'pending', checkedAt: new Date() },
              $setOnInsert: { tenantId: new Types.ObjectId(event.tenantId) },
            },
            { upsert: true },
          );
          void this.commands
            .send({
              type: 'refresh_avatar',
              tenantId: event.tenantId,
              accountId: event.accountId,
              contactId: senderId,
            })
            .catch(() => false);
        }
      } catch {
        this.logger.warn('Notification avatar refresh unavailable');
      }
    return { title, body: pushMessagePreview(event.message), contactId: senderId };
  }

  avatarUrl(
    event: Extract<DomainEvent, { type: 'message.created' }>,
    userId: string,
    contactId?: string,
  ): string {
    if (!contactId || !process.env.JWT_ACCESS_SECRET) return '/assets/imgs/logo.webp';
    const token = signPushAvatar(
      {
        tenantId: event.tenantId,
        userId,
        accountId: event.accountId,
        conversationId: event.conversationId,
        contactId,
        expires: Date.now() + 300000,
      },
      process.env.JWT_ACCESS_SECRET,
    );
    return `/api/v1/message-push/avatar/${token}`;
  }

  async openAvatar(token: string) {
    const claims = verifyPushAvatar(token, process.env.JWT_ACCESS_SECRET ?? '');
    return runInTenant(claims.tenantId, async () => {
      const user = await this.users
        .findOne({ _id: claims.userId, tenantId: claims.tenantId, status: 'active' })
        .lean();
      if (!user) throw new NotFoundException();
      const role = await this.roles.findOne({ _id: user.roleId, tenantId: claims.tenantId }).lean();
      if (!role) throw new NotFoundException();
      const permissions = role.permissions.filter(isPermission);
      const resolved = await this.access.resolve(claims.tenantId, claims.userId, permissions);
      const ability = defineAbilityFor(
        { id: claims.userId, tenantId: claims.tenantId },
        { permissions },
        [...resolved.accounts].map(([accountId, level]) => ({ accountId, level })),
      );
      if (!ability.can('read', 'Conversation')) throw new NotFoundException();
      const conversation = await this.conversations
        .findOne({
          $and: [
            { _id: claims.conversationId, accountId: claims.accountId, tenantId: claims.tenantId },
            accessibleBy(ability, 'read').ofType('Conversation'),
          ],
        })
        .lean();
      if (
        !conversation ||
        !(await this.accounts.exists({ _id: claims.accountId, tenantId: claims.tenantId }))
      )
        throw new NotFoundException();
      if (conversation.contactId.toString() !== claims.contactId) {
        const senderMessage = await this.messages.exists({
          $and: [
            {
              tenantId: claims.tenantId,
              accountId: claims.accountId,
              conversationId: claims.conversationId,
              senderContactId: claims.contactId,
            },
            accessibleBy(ability, 'read').ofType('Message'),
          ],
        });
        if (!senderMessage) throw new NotFoundException();
      }
      const avatar = await this.avatars
        .findOne({
          tenantId: claims.tenantId,
          accountId: claims.accountId,
          contactId: claims.contactId,
        })
        .lean();
      if (!avatar?.storageKey || !avatar.storageDriver) return null;
      try {
        return {
          ...(await this.storage.forDriver(avatar.storageDriver).open(avatar.storageKey)),
          mimeType: avatar.mimeType ?? 'image/jpeg',
        };
      } catch {
        return null;
      }
    });
  }
}
