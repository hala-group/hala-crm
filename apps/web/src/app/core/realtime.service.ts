import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { io, type Socket } from 'socket.io-client';
import { firstValueFrom } from 'rxjs';
import { type Me } from './models';
import { PermissionsStore } from './permissions.store';
import { AccountsStore } from '../features/accounts/accounts.store';
import { InboxStore } from '../features/inbox/inbox.store';
import { MessagesStore } from '../features/inbox/messages.store';
import { CallAlertsStore } from './call-alerts.store';
import { CallHistoryStore } from '../features/inbox/call-history.store';
import { type CallEvent } from './call-alerts';
import { type ConversationView, type MessageView } from '@hala/shared';

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly http = inject(HttpClient);
  private readonly permissions = inject(PermissionsStore);
  private readonly accounts = inject(AccountsStore);
  private readonly inbox = inject(InboxStore);
  private readonly messages = inject(MessagesStore);
  private readonly callAlerts = inject(CallAlertsStore);
  private readonly callHistory = inject(CallHistoryStore);
  private socket?: Socket;
  readonly typing = signal<{ conversationId: string; userId: string } | null>(null);

  start(token: string): void {
    this.stop();
    const socket = io('/realtime', { auth: { token }, transports: ['websocket'] });
    this.socket = socket;
    socket.on('access:updated', () => {
      void firstValueFrom(this.http.get<Me>('/api/v1/me')).then(me => {
        this.permissions.setCurrent(me);
        void this.callAlerts.syncSubscription();
      });
      void this.accounts.load().catch(() => this.accounts.clear());
      this.inbox.clear(); this.messages.clear();
      this.callAlerts.clear();
      this.callHistory.clear();
    });
    socket.on('account:status', (event: { accountId: string; status: 'created' | 'qr_pending' | 'connecting' | 'connected' | 'disconnected' | 'logged_out' | 'error'; phoneNumber?: string }) => this.accounts.applyStatus(event));
    socket.on('account:qr', (event: { accountId: string; qr: string }) => {
      void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(event.qr)).then(image => this.accounts.showQr({ accountId: event.accountId, image }));
    });
    socket.on('conversation:updated', (conversation: ConversationView) => this.inbox.apply(conversation));
    socket.on('message:new', (message: MessageView) => this.messages.upsert(message));
    socket.on('message:updated', (event: MessageView | { messageId: string; mediaId: string }) => {
      if ('messageId' in event) this.messages.mediaReady(event.messageId, event.mediaId);
      else this.messages.upsert(event);
    });
    socket.on('message:status', (event: { messageId: string; conversationId?: string; status: MessageView['status']; waMessageId?: string; failureReason?: string }) => {
      this.messages.updateStatus(event);
      if (event.conversationId) this.inbox.updateLastMessageStatus(event.conversationId, event.status);
    });
    socket.on('call:incoming', (event: CallEvent) => { this.callAlerts.receive(event, 'incoming'); void this.callHistory.load(); void this.inbox.load(); });
    socket.on('call:missed', (event: CallEvent) => { this.callAlerts.receive(event, 'missed'); void this.callHistory.load(); void this.inbox.load(); });
    socket.on('typing:start', (event: { conversationId: string; userId: string }) => this.typing.set(event));
    socket.on('typing:stop', (event: { conversationId: string }) => {
      if (this.typing()?.conversationId === event.conversationId) this.typing.set(null);
    });
  }

  stop(): void { this.socket?.disconnect(); this.socket = undefined; this.callAlerts.clear(); this.callHistory.clear(); }
  setTyping(conversationId: string, active: boolean): void {
    this.socket?.emit(active ? 'typing:start' : 'typing:stop', { conversationId });
  }
}
