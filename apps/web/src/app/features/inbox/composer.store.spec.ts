import '@angular/compiler';
import { createEnvironmentInjector, Injector } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type ConversationView, type MessageView } from '@hala/shared';
import { MessagesStore } from './messages.store';
import { InboxStore } from './inbox.store';
import { ComposerStore } from './composer.store';

const conversation: ConversationView = { _id: 'c1', tenantId: 't1', accountId: 'a1', contactId: 'p1',
  contactName: 'Ali', contactWaId: '2010@s.whatsapp.net', status: 'open', lastMessageAt: new Date().toISOString(),
  lastMessagePreview: '', lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: 0 };

describe('ComposerStore', () => {
  it('optimistically inserts and replaces a sent message by client ID', async () => {
    const http = { get: vi.fn(() => of({ items: [], nextCursor: null })),
      post: vi.fn((_url: string, input: { clientMessageId: string }) => of({ _id: 'db-id',
        clientMessageId: input.clientMessageId, tenantId: 't1', accountId: 'a1', conversationId: 'c1', contactId: 'p1',
        waMessageId: 'wa', direction: 'out', type: 'text', text: 'Hello', status: 'pending', timestamp: new Date().toISOString() } as MessageView)) };
    const injector = createEnvironmentInjector([InboxStore, MessagesStore, ComposerStore, { provide: HttpClient, useValue: http }], Injector.NULL);
    const messages = injector.get(MessagesStore);
    const composer = injector.get(ComposerStore);
    await messages.select('c1');
    expect(await composer.send(conversation, { type: 'text', text: 'Hello', linkPreview: true })).toBe(true);
    expect(messages.items()).toHaveLength(1);
    expect(messages.items()[0]?._id).toBe('db-id');
    expect(http.post).toHaveBeenCalledTimes(1);
    injector.destroy();
  });
  it('keeps the text draft context when sending a reaction to a message', async () => {
    const target = { _id: 'target', tenantId: 't1', accountId: 'a1', conversationId: 'c1',
      contactId: 'p1', waMessageId: 'wa-target', direction: 'in', type: 'text', text: 'Hello',
      status: 'delivered', timestamp: new Date().toISOString() } as MessageView;
    const http = { get: vi.fn(() => of({ items: [target], nextCursor: null })),
      post: vi.fn((_url: string, input: { clientMessageId: string; type: string; replyToMessageId?: string }) => of({
        ...target, _id: 'reaction-id', clientMessageId: input.clientMessageId, type: 'reaction',
        direction: 'out', reaction: { targetWaMessageId: 'wa-target', emoji: '❤️' }
      } as MessageView)) };
    const injector = createEnvironmentInjector([InboxStore, MessagesStore, ComposerStore, { provide: HttpClient, useValue: http }], Injector.NULL);
    const messages = injector.get(MessagesStore);
    const composer = injector.get(ComposerStore);
    await messages.select('c1');
    composer.reply('target');
    expect(await composer.send(conversation, { type: 'reaction', targetMessageId: 'target', emoji: '❤️' })).toBe(true);
    expect(http.post.mock.calls[0]?.[1]).not.toHaveProperty('replyToMessageId');
    expect(composer.replyToMessageId()).toBe('target');
    expect(composer.type()).toBe('text');
    expect(messages.items().find(item => item.type === 'reaction')?.reaction?.emoji).toBe('❤️');
    injector.destroy();
  });
});
