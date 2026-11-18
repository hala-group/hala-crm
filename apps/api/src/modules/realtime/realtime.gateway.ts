import { Inject, OnModuleDestroy } from '@nestjs/common';
import { accessibleBy } from '@casl/mongoose';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, SubscribeMessage, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import { type Model } from 'mongoose';
import { Namespace, Socket } from 'socket.io';
import { defineAbilityFor, isPermission, subject, typingSchema, type ProviderEvent, type DomainEvent, type HalaAbility } from '@hala/shared';
import { validateEnvironment } from '../../config/environment.js';
import { runInTenant } from '../../common/tenant-context.js';
import { type UserRecord } from '../users/user.schema.js';
import { type RoleRecord } from '../roles/role.schema.js';
import { type RefreshSessionRecord } from '../auth/auth.schema.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type ConversationRecord } from '../inbox/inbox.schema.js';
import { AccountAccessService } from '../access/account-access.service.js';
import { RedisBusService } from '../access/redis-bus.service.js';
import { CallsService } from '../calls/calls.service.js';
import { CallPushService } from '../calls/call-push.service.js';
import { MessagePushService } from '../message-push/message-push.service.js';

interface Claims { sub: string; tenantId: string; sid: string; typ: string }

@WebSocketGateway({ namespace: '/realtime', cors: { origin: process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:4200'], credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server!: Namespace;
  private readonly stopListening: () => void;

  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @InjectModel('User') private readonly users: Model<UserRecord>,
    @InjectModel('Role') private readonly roles: Model<RoleRecord>,
    @InjectModel('RefreshSession') private readonly sessions: Model<RefreshSessionRecord>,
    @InjectModel('WhatsAppAccount') private readonly accounts: Model<WhatsAppAccountRecord>,
    @InjectModel('Conversation') private readonly conversations: Model<ConversationRecord>,
    @Inject(AccountAccessService) private readonly access: AccountAccessService,
    @Inject(RedisBusService) private readonly bus: RedisBusService,
    @Inject(CallsService) private readonly calls: CallsService,
    @Inject(CallPushService) private readonly callPush: CallPushService,
    @Inject(MessagePushService) private readonly messagePush: MessagePushService
  ) {
    this.stopListening = this.bus.listen(event => {
      if (event.type === 'access.changed') return this.refreshUser(event.userId, event.tenantId);
      else if (event.type === 'account.deleted') return this.removeDeletedAccount(event.accountId, event.tenantId);
      else if (event.type === 'call.incoming' || event.type === 'call.missed') return this.broadcastCall(event);
      else if (event.type === 'message.created') {
        void this.messagePush.deliver(event);
        return this.broadcastDomainEvent(event);
      } else if (event.type === 'message.media_ready' || event.type === 'message.status' || event.type === 'message.updated' || event.type === 'conversation.updated' || event.type === 'typing') return this.broadcastDomainEvent(event);
      else if (event.type === 'wa.qr' || event.type === 'wa.connection') this.broadcastProviderEvent(event);
    });
  }

  private async authorize(token: string) {
    const claims = await this.jwt.verifyAsync<Claims>(token, { secret: validateEnvironment(process.env).JWT_ACCESS_SECRET });
    if (claims.typ !== 'access' || !claims.tenantId || !claims.sid || !claims.sub) throw new Error('Invalid token');
    return runInTenant(claims.tenantId, async () => {
      const [session, user] = await Promise.all([
        this.sessions.findOne({ _id: claims.sid, revokedAt: null }).lean(),
        this.users.findById(claims.sub).lean()
      ]);
      if (!session || session.expiresAt <= new Date() || !user || user.status !== 'active' || user.tenantId.toString() !== claims.tenantId) throw new Error('Inactive session');
      const role = await this.roles.findById(user.roleId).lean();
      if (!role) throw new Error('Role missing');
      const permissions = role.permissions.filter(isPermission);
      const resolved = await this.access.resolve(claims.tenantId, claims.sub, permissions);
      const memberships = [...resolved.accounts].map(([accountId, level]) => ({ accountId, level }));
      const ability = defineAbilityFor({ id: claims.sub, tenantId: claims.tenantId }, { permissions }, memberships);
      return { claims, ability, memberships, all: resolved.all };
    });
  }

  private async assignRooms(client: Socket, token: string): Promise<void> {
    const authorized = await this.authorize(token);
    const { claims, ability, memberships, all } = authorized;
    for (const room of client.rooms) if (room.startsWith('account:') || room.startsWith('user:')) await client.leave(room);
    await client.join(`user:${claims.sub}`);
    const ids = all
      ? await runInTenant(claims.tenantId, async () => this.accounts.find().select('_id').lean())
        .then(records => records.map(record => record._id.toString()))
      : memberships.map(member => member.accountId);
    for (const id of ids) {
      const resource = subject('WhatsAppAccount', { _id: id, tenantId: claims.tenantId });
      const conversation = subject('Conversation', { accountId: id, tenantId: claims.tenantId, assignedUserId: null });
      if (ability.can('read', resource) || ability.can('connect', resource) || ability.can('members', resource) || ability.can('read', conversation)) await client.join(`account:${id}`);
      if (ability.can('connect', resource)) await client.join(`account:${id}:manage`);
    }
    client.data['userId'] = claims.sub;
    client.data['tenantId'] = claims.tenantId;
    client.data['ability'] = ability;
  }

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth['token'];
    if (typeof token !== 'string') { client.disconnect(true); return; }
    try {
      await this.assignRooms(client, token);
      client.data['token'] = token;
      client.emit('ready');
    } catch {
      client.disconnect(true);
    }
  }

  private async refreshUser(userId: string, tenantId: string): Promise<void> {
    if (!this.server) return;
    for (const client of this.server.sockets.values()) {
      if (client.data['userId'] !== userId || client.data['tenantId'] !== tenantId) continue;
      try {
        await this.assignRooms(client, client.data['token'] as string);
        client.emit('access:updated', { accountIds: [...client.rooms].filter(room => room.startsWith('account:') && !room.endsWith(':manage')) });
      } catch { client.disconnect(true); }
    }
  }

  private broadcastProviderEvent(event: ProviderEvent): void {
    if (!this.server) return;
    if (event.type === 'wa.qr') this.server.local.to(`account:${event.accountId}:manage`).emit('account:qr', { accountId: event.accountId, qr: event.qr });
    else if (event.type === 'wa.connection') this.server.local.to(`account:${event.accountId}`).emit('account:status', event);
  }

  private async broadcastDomainEvent(event: Extract<DomainEvent, { type: 'message.created' | 'message.media_ready' | 'message.status' | 'message.updated' | 'conversation.updated' | 'typing' }>): Promise<void> {
    if (!this.server) return;
    const conversationId = event.type === 'conversation.updated' ? event.conversation._id : event.conversationId;
    for (const client of this.server.sockets.values()) {
      if (client.data['tenantId'] !== event.tenantId || !client.rooms.has(`account:${event.accountId}`)) continue;
      const ability = client.data['ability'] as HalaAbility | undefined;
      const assignedUserId = event.type === 'conversation.updated' ? event.conversation.assignedUserId : event.assignedUserId;
      if (!ability?.can('read', subject('Conversation', {
        tenantId: event.tenantId, accountId: event.accountId, assignedUserId: assignedUserId ?? null
      }))) continue;
      const accessible = await runInTenant(event.tenantId, async () => this.conversations.exists({ $and: [
        { _id: conversationId, accountId: event.accountId }, accessibleBy(ability, 'read').ofType('Conversation')
      ] }));
      if (!accessible) continue;
      if (event.type === 'message.created') client.emit('message:new', event.message);
      else if (event.type === 'message.media_ready') client.emit('message:updated', event);
      else if (event.type === 'message.status') client.emit('message:status', event);
      else if (event.type === 'message.updated') client.emit('message:updated', event.message);
      else if (event.type === 'typing') client.emit(event.active ? 'typing:start' : 'typing:stop', event);
      else client.emit('conversation:updated', event.conversation);
    }
  }

  private async broadcastCall(event: Extract<DomainEvent, { type: 'call.incoming' | 'call.missed' }>): Promise<void> {
    void this.callPush.deliver(event);
    if (!this.server) return;
    for (const client of this.server.sockets.values()) {
      if (client.data['tenantId'] !== event.tenantId || !client.rooms.has(`account:${event.accountId}`)) continue;
      const userId = client.data['userId'] as string | undefined;
      if (!userId) continue;
      const visible = await this.calls.canReadForUser(event.tenantId, userId, event.callId);
      if (visible) client.emit(event.type === 'call.incoming' ? 'call:incoming' : 'call:missed', event);
    }
  }

  @SubscribeMessage('typing:start')
  async typingStart(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<void> {
    await this.typing(client, body, true);
  }

  @SubscribeMessage('typing:stop')
  async typingStop(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): Promise<void> {
    await this.typing(client, body, false);
  }

  private async typing(client: Socket, body: unknown, active: boolean): Promise<void> {
    const parsed = typingSchema.safeParse(body);
    const ability = client.data['ability'] as HalaAbility | undefined;
    const tenantId = client.data['tenantId'] as string | undefined;
    const userId = client.data['userId'] as string | undefined;
    if (!parsed.success || !ability || !tenantId || !userId) return;
    if (!(await this.bus.consume(`rate:typing:${tenantId}:${userId}`, 120, 60))) return;
    const conversation = await runInTenant(tenantId, async () => this.conversations.findOne({ $and: [
      { _id: parsed.data.conversationId }, accessibleBy(ability, 'read').ofType('Conversation')
    ] }).lean());
    if (!conversation || !ability.can('send', subject('Message', { tenantId, accountId: conversation.accountId.toString() }))) return;
    await this.bus.publish({ type: 'typing', tenantId, accountId: conversation.accountId.toString(),
      conversationId: conversation._id.toString(), assignedUserId: conversation.assignedUserId?.toString() ?? null,
      userId, active });
  }

  private async removeDeletedAccount(accountId: string, tenantId: string): Promise<void> {
    if (!this.server) return;
    for (const client of this.server.sockets.values()) {
      if (client.data['tenantId'] !== tenantId) continue;
      if (!client.rooms.has(`account:${accountId}`) && !client.rooms.has(`account:${accountId}:manage`)) continue;
      await client.leave(`account:${accountId}`);
      await client.leave(`account:${accountId}:manage`);
      client.emit('access:updated', { accountIds: [...client.rooms].filter(room => room.startsWith('account:') && !room.endsWith(':manage')) });
    }
  }

  onModuleDestroy(): void { this.stopListening(); }
}
