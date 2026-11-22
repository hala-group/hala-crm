import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { accessibleBy } from '@casl/mongoose';
import { InjectModel } from '@nestjs/mongoose';
import {
  defineAbilityFor,
  isPermission,
  subject,
  type DomainEvent,
  type HalaAbility,
  type Permission,
} from '@hala/shared';
import { type Model, Types } from 'mongoose';
import { runInTenant } from '../../common/tenant-context.js';
import { type Principal } from '../../common/auth.types.js';
import { AccountAccessService } from '../access/account-access.service.js';
import { RedisBusService } from '../access/redis-bus.service.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type UserRecord } from '../users/user.schema.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type ConversationRecord } from '../inbox/inbox.schema.js';
import { FirebaseMessagingService } from './firebase-messaging.service.js';
import { type MessagePushInstallationRecord } from './message-push.schema.js';
import { MessagePushContentService } from './message-push-content.service.js';

type IncomingMessageEvent = Extract<DomainEvent, { type: 'message.created' }>;

/** FCM counts UTF-8 bytes, including metadata. Leave room for signed photos and grouping fields. */
function pushText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = ''; let bytes = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character, 'utf8');
    if (bytes + length > maxBytes - 3) break;
    result += character; bytes += length;
  }
  return `${result}…`;
}

@Injectable()
export class MessagePushService {
  private readonly logger = new Logger(MessagePushService.name);

  constructor(
    @InjectModel('MessagePushInstallation')
    private readonly installations: Model<MessagePushInstallationRecord>,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @InjectModel('WhatsAppAccount') private readonly accounts: Model<WhatsAppAccountRecord>,
    @InjectModel('Conversation') private readonly conversations: Model<ConversationRecord>,
    @Inject(FirebaseMessagingService) private readonly firebase: FirebaseMessagingService,
    @Inject(AccountAccessService) private readonly access: AccountAccessService,
    @Inject(RedisBusService) private readonly bus: RedisBusService,
    @Inject(MessagePushContentService) private readonly content: MessagePushContentService,
  ) {}

  config() {
    return this.firebase.config();
  }

  async subscribe(principal: Principal, fid: string): Promise<{ ok: true }> {
    if (!this.firebase.isConfigured())
      throw new ServiceUnavailableException('Firebase message push is not configured');
    const tenantId = new Types.ObjectId(principal.tenantId);
    const userId = new Types.ObjectId(principal.id);
    const filter = { fid };
    const update = {
      $set: { userId, lastRegisteredAt: new Date() },
      $setOnInsert: { tenantId, fid },
    };
    try {
      await runInTenant(principal.tenantId, () =>
        this.installations.updateOne(filter, update, { upsert: true }).exec(),
      );
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000)
        throw error;
      await runInTenant(principal.tenantId, () =>
        this.installations
          .updateOne(filter, {
            $set: { userId, lastRegisteredAt: new Date() },
          })
          .exec(),
      );
    }
    return { ok: true };
  }

  async unsubscribe(principal: Principal, fid: string): Promise<{ ok: true }> {
    await runInTenant(principal.tenantId, () =>
      this.installations
        .deleteOne({
          tenantId: new Types.ObjectId(principal.tenantId),
          userId: new Types.ObjectId(principal.id),
          fid,
        })
        .exec(),
    );
    return { ok: true };
  }

  async deliver(event: IncomingMessageEvent): Promise<void> {
    if (
      !this.firebase.isConfigured() ||
      event.message.direction !== 'in' ||
      event.message.type === 'system'
    )
      return;
    try {
      const key = `message-fcm:${event.tenantId}:${event.accountId}:${event.message.waMessageId}`;
      if (!(await this.bus.consume(key, 1, 86_400))) return;
      await runInTenant(event.tenantId, async () => this.deliverInTenant(event));
    } catch (error) {
      this.logger.warn(`Firebase message push fan-out failed (${this.errorCode(error)})`);
    }
  }

  private async deliverInTenant(event: IncomingMessageEvent): Promise<void> {
    const tenantId = new Types.ObjectId(event.tenantId);
    const accountId = new Types.ObjectId(event.accountId);
    const conversationId = new Types.ObjectId(event.conversationId);
    if (!(await this.accounts.exists({ _id: accountId, tenantId }))) return;
    const conversation = await this.conversations
      .findOne({ _id: conversationId, tenantId, accountId })
      .select('_id assignedUserId contactId unreadCount updatedAt')
      .lean();
    if (!conversation) return;

    const activeUsers = await this.users
      .find({ tenantId, status: 'active' })
      .select('_id roleId')
      .lean();
    if (!activeUsers.length) return;
    const roleIds = [...new Set(activeUsers.map((user) => user.roleId.toString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const roles = await this.roles
      .find({ tenantId, _id: { $in: roleIds } })
      .select('_id permissions')
      .lean();
    const roleMap = new Map(roles.map((role) => [role._id.toString(), role]));
    const authorizedIds: Types.ObjectId[] = [];

    for (let offset = 0; offset < activeUsers.length; offset += 12) {
      const batch = activeUsers.slice(offset, offset + 12);
      const eligibility = await Promise.all(
        batch.map(async (user) => {
          const role = roleMap.get(user.roleId.toString());
          if (!role) return false;
          const permissions = role.permissions.filter(isPermission) as Permission[];
          const userId = user._id.toString();
          const resolved = await this.access.resolve(event.tenantId, userId, permissions);
          const memberships = [...resolved.accounts].map(([id, level]) => ({
            accountId: id,
            level,
          }));
          const ability: HalaAbility = defineAbilityFor(
            { id: userId, tenantId: event.tenantId },
            { permissions },
            memberships,
          );
          const assignedUserId = conversation.assignedUserId?.toString() ?? null;
          if (
            !ability.can(
              'read',
              subject('Conversation', {
                tenantId: event.tenantId,
                accountId: event.accountId,
                assignedUserId,
              }),
            )
          )
            return false;
          const currentAccess = await this.conversations.exists({
            $and: [
              { _id: conversationId, tenantId, accountId, assignedUserId },
              accessibleBy(ability, 'read').ofType('Conversation'),
            ],
          });
          return Boolean(currentAccess);
        }),
      );
      batch.forEach((user, index) => {
        if (eligibility[index]) authorizedIds.push(user._id);
      });
    }
    if (!authorizedIds.length) return;

    const registrations = await this.installations
      .find({ tenantId, userId: { $in: authorizedIds } })
      .lean();
    if (!registrations.length) return;
    const preview = await this.content.describe(event, conversation.contactId.toString());
    const senderTitle = pushText(preview.title, 192);
    const body = pushText(preview.body, 384);
    const path = `/inbox/${encodeURIComponent(event.conversationId)}`;
    const recipients = new Map<string, typeof registrations>();
    for (const registration of registrations) {
      const userId = registration.userId.toString();
      const list = recipients.get(userId) ?? [];
      list.push(registration);
      recipients.set(userId, list);
    }
    for (const [userId, devices] of recipients) {
      const icon = this.content.avatarUrl(event, userId, preview.contactId);
      const unreadCount = Math.max(1, Math.trunc(conversation.unreadCount || 1));
      const revision = conversation.updatedAt?.getTime() ?? Date.now();
      const messageTimestamp = Date.parse(event.message.timestamp) || revision;
      const title = unreadCount > 1 ? `${senderTitle} (${unreadCount})` : senderTitle;
      const grouping = {
        groupingVersion: '1', tenantId: event.tenantId, accountId: event.accountId,
        recipientId: userId, conversationId: event.conversationId, messageId: event.message._id,
        unreadCount: String(unreadCount), revision: String(revision), messageTimestamp: String(messageTimestamp)
      };
      for (let offset = 0; offset < devices.length; offset += 500) {
        const batch = devices.slice(offset, offset + 500);
        const response = await this.firebase.sendEachForMulticast({
          fids: batch.map((registration) => registration.fid),
          notification: { title, body },
          data: {
            ...grouping,
            icon,
            type: 'message.received',
            conversationId: event.conversationId,
            messageId: event.message._id,
            url: path,
          },
          webpush: {
            headers: { TTL: '86400' },
            notification: {
              title,
              body,
              icon,
              tag: `message:${event.tenantId}:${event.accountId}:${userId}:${event.conversationId}`,
              renotify: false,
              data: {
                halaMessage: grouping,
                onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: path } },
              },
            },
          },
        });
        await Promise.all(
          response.responses.map(async (result, index) => {
            if (result.success || result.error?.code !== 'messaging/installation-id-not-registered')
              return;
            const registration = batch[index];
            if (!registration) return;
            await this.installations
              .deleteOne({ tenantId, userId: registration.userId, fid: registration.fid })
              .exec();
          }),
        );
      }
    }
  }

  private errorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('code' in error)) return 'unknown';
    const code = error.code;
    return typeof code === 'string' ? code.slice(0, 80) : 'unknown';
  }
}
