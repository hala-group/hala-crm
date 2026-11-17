import '@angular/compiler';
import { createEnvironmentInjector, Injector } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type ConversationView, type MessageView } from '@hala/shared';
import { InboxStore } from './inbox.store';
import { MessagesStore } from './messages.store';

const conversation: ConversationView = {
  _id: 'c1',
  tenantId: 't1',
  accountId: 'a1',
  contactId: 'p1',
  contactName: 'Ali',
  contactWaId: '2010@s.whatsapp.net',
  status: 'open',
  lastMessageAt: '2026-10-24T00:00:00.000Z',
  lastMessagePreview: 'Hello',
  lastMessageType: 'text',
  lastMessageDirection: 'in',
  unreadCount: 1,
};
const message: MessageView = {
  _id: 'm1',
  tenantId: 't1',
  accountId: 'a1',
  conversationId: 'c1',
  contactId: 'p1',
  waMessageId: 'wa1',
  direction: 'in',
  type: 'text',
  timestamp: '2026-10-24T00:00:00.000Z',
  text: 'Hello',
  status: 'delivered',
};

describe('Inbox SignalStores', () => {
  it('loads cursor pages and applies live conversation updates', async () => {
    const http = { get: vi.fn(() => of({ items: [conversation], nextCursor: 'next' })) };
    const injector = createEnvironmentInjector(
      [InboxStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(InboxStore);
    await store.load();
    expect(store.items()).toHaveLength(1);
    expect(store.cursor()).toBe('next');
    store.apply({ ...conversation, lastMessagePreview: 'Updated' });
    expect(store.items()[0]?.lastMessagePreview).toBe('Updated');
    store.select('c1');
    expect(store.selectedId()).toBe('c1');
    store.select(null);
    expect(store.selectedId()).toBeNull();
    await store.load(false);
    expect(store.items()).toHaveLength(1);
    store.clear();
    expect(store.items()).toEqual([]);
    injector.destroy();
  });

  it('exposes a recoverable error when loading the inbox fails', async () => {
    const http = {
      get: vi
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('offline')))
        .mockReturnValueOnce(of({ items: [conversation], nextCursor: null })),
    };
    const injector = createEnvironmentInjector(
      [InboxStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(InboxStore);

    await store.load();
    expect(store.error()).toContain('تعذر تحميل المحادثات');
    expect(store.loading()).toBe(false);

    await store.load();
    expect(store.error()).toBeNull();
    expect(store.items()).toEqual([conversation]);
    injector.destroy();
  });

  it('discards stale inbox responses when filters change during a request', async () => {
    const firstPage = new Subject<{ items: ConversationView[]; nextCursor: null }>();
    const latestPage = new Subject<{ items: ConversationView[]; nextCursor: null }>();
    const latestConversation = {
      ...conversation,
      _id: 'c2',
      accountId: 'a2',
      contactName: 'Sara',
      lastMessagePreview: 'Latest filter result',
    };
    const http = {
      get: vi.fn().mockReturnValueOnce(firstPage).mockReturnValueOnce(latestPage),
    };
    const injector = createEnvironmentInjector(
      [InboxStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(InboxStore);
    store.filter('a1', 'old query');
    const firstRequest = store.load();

    store.filter('a2', 'latest query');
    const latestRequest = store.load();
    expect(http.get).toHaveBeenCalledTimes(2);

    firstPage.next({ items: [conversation], nextCursor: null });
    firstPage.complete();
    await firstRequest;
    expect(store.items()).toEqual([]);
    expect(store.loading()).toBe(true);

    latestPage.next({ items: [latestConversation], nextCursor: null });
    latestPage.complete();
    await latestRequest;
    expect(store.items()).toEqual([latestConversation]);
    expect(store.loading()).toBe(false);
    injector.destroy();
  });

  it('filters by tab, loads tags, and updates conversation tags', async () => {
    const http = {
      get: vi.fn((url: string) => {
        if (url.includes('/api/v1/tags')) return of({ tags: ['VIP', 'Lead'] });
        return of({ items: [conversation], nextCursor: null });
      }),
      patch: vi.fn(() => of({ ...conversation, tags: ['VIP'] })),
      post: vi.fn(() => of({ ...conversation, status: 'archived' })),
    };
    const injector = createEnvironmentInjector(
      [InboxStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(InboxStore);

    store.setFilterTab('unread');
    expect(store.filterTab()).toBe('unread');
    await store.load();

    await store.loadTags();
    expect(store.availableTags()).toEqual(['VIP', 'Lead']);

    await store.updateTags('c1', ['VIP', 'New']);
    expect(store.items()[0]?.tags).toEqual(['VIP']);
    expect(store.availableTags()).toContain('New');

    await store.archive('c1', true);
    // Because filterTab is 'unread' (not 'archived'), archiving removes it from the unread list
    expect(store.items()).toHaveLength(0);

    injector.destroy();
  });

  it('searches messages and clears search', async () => {
    const searchResult = {
      message,
      contactName: 'Ali',
      contactWaId: '2010@s.whatsapp.net',
    };
    const http = {
      get: vi.fn(() => of({ items: [searchResult] })),
    };
    const injector = createEnvironmentInjector(
      [InboxStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(InboxStore);

    await store.searchMessages('Hello');
    expect(store.messageSearchResults()).toHaveLength(1);
    expect(store.messageSearchResults()[0]?.contactName).toBe('Ali');

    store.clearMessageSearch();
    expect(store.messageSearchResults()).toHaveLength(0);
    expect(store.messageSearchQuery()).toBe('');
    injector.destroy();
  });

  it('deduplicates realtime messages and marks media ready', async () => {
    const http = { get: vi.fn(() => of({ items: [message], nextCursor: null })) };
    const injector = createEnvironmentInjector(
      [MessagesStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(MessagesStore);
    await store.select('c1');
    store.add(message);
    expect(store.items()).toHaveLength(1);
    store.mediaReady('m1', 'media1');
    expect(store.items()[0]?.mediaId).toBe('media1');
    injector.destroy();
  });

  it('exposes a recoverable error when loading messages fails', async () => {
    const http = {
      get: vi
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('offline')))
        .mockReturnValueOnce(of({ items: [message], nextCursor: null })),
    };
    const injector = createEnvironmentInjector(
      [MessagesStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(MessagesStore);

    await store.select('c1');
    expect(store.error()).toContain('تعذر تحميل الرسائل');
    expect(store.loading()).toBe(false);

    await store.load();
    expect(store.error()).toBeNull();
    expect(store.loadedConversationId()).toBe('c1');
    expect(store.items()).toEqual([message]);
    injector.destroy();
  });

  it('waits for the selected chat when a previous conversation request is still pending', async () => {
    const first = new Subject<{ items: MessageView[]; nextCursor: null }>();
    const second = new Subject<{ items: MessageView[]; nextCursor: null }>();
    const http = { get: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) };
    const injector = createEnvironmentInjector(
      [MessagesStore, { provide: HttpClient, useValue: http }],
      Injector.NULL,
    );
    const store = injector.get(MessagesStore);
    const firstSelection = store.select('c1');
    const secondSelection = store.select('c2');

    first.next({ items: [message], nextCursor: null });
    first.complete();
    await firstSelection;
    await vi.waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));

    const secondMessage = { ...message, _id: 'm2', conversationId: 'c2', text: 'Second chat' };
    second.next({ items: [secondMessage], nextCursor: null });
    second.complete();
    await Promise.all([firstSelection, secondSelection]);
    expect(store.conversationId()).toBe('c2');
    expect(store.items().map((item) => item.text)).toEqual(['Second chat']);
    injector.destroy();
  });
});
