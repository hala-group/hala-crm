import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../public/hala-sw.js', import.meta.url), 'utf8');
const ids = { tenantId: '507f1f77bcf86cd799439011', accountId: '507f1f77bcf86cd799439012',
  recipientId: '507f1f77bcf86cd799439013', conversationId: '507f1f77bcf86cd799439014', messageId: '507f1f77bcf86cd799439015' };
function payload(overrides: Record<string, unknown> = {}) {
  return { notification: { title: 'علي', body: 'مرحباً', icon: '/avatar' }, data: { ...ids,
    groupingVersion: '1', senderTitle: 'علي', messagePreview: 'مرحباً', unreadCount: '1', revision: '1000', messageTimestamp: '1000', ...overrides } };
}

function worker() {
  type Options = { tag: string; silent: boolean; renotify: boolean; body: string; data: { halaMessage?: Record<string, unknown>; onActionClick: unknown } };
  type Visible = { title: string; tag: string; data: Options['data']; options: Options; close: () => void };
  type Event = { data: unknown; waitUntil: (work: Promise<unknown>) => void; stopImmediatePropagation?: () => void };
  const listeners = new Map<string, (event: Event) => void>();
  const visible: Visible[] = [];
  const broadcast = vi.fn();
  const showNotification = vi.fn(async (title: string, options: Options) => {
    // Simulate a browser which doesn't replace notifications by tag automatically.
    const item: Visible = { title, options, tag: options.tag, data: options.data,
      close: () => { const index = visible.indexOf(item); if (index >= 0) visible.splice(index, 1); } };
    visible.push(item);
  });
  const registration = { showNotification, getNotifications: vi.fn(async (options?: { tag?: string }) =>
    visible.filter(item => !options?.tag || item.tag === options.tag)) };
  const importScripts = vi.fn();
  runInNewContext(source, { self: { registration, clients: { matchAll: async () => [{ postMessage: broadcast }] },
    addEventListener: (name: string, handler: (event: Event) => void) => { listeners.set(name, handler); } }, importScripts });
  const push = async (data: unknown) => {
    const work: Promise<unknown>[] = [];
    const stop = vi.fn();
    listeners.get('push')!({ data: { json: () => data }, stopImmediatePropagation: stop, waitUntil: promise => { work.push(promise); } });
    await Promise.all(work);
    return stop;
  };
  const close = async (data: Record<string, unknown>) => {
    const work: Promise<unknown>[] = [];
    listeners.get('message')!({ data: { type: 'HALA_CLOSE_MESSAGE_NOTIFICATIONS', ...data }, waitUntil: promise => { work.push(promise); } });
    await Promise.all(work);
  };
  return { visible, showNotification, registration, importScripts, push, close, broadcast };
}

describe('conversation message push worker', () => {
  it('imports Angular and explicitly replaces a conversation notification silently with its current count and preview', async () => {
    const h = worker();
    expect(h.importScripts).toHaveBeenCalledWith('./ngsw-worker.js');
    expect(await h.push(payload())).toHaveBeenCalledOnce();
    expect(h.visible[0]?.options.silent).toBe(false);
    await h.push(payload({ unreadCount: '2', revision: '2000', messageTimestamp: '2000', messageId: '507f1f77bcf86cd799439016', messagePreview: 'آخر رسالة' }));
    expect(h.visible).toHaveLength(1);
    expect(h.visible[0]).toMatchObject({ title: 'علي (2)', options: { body: 'آخر رسالة', silent: true, renotify: false,
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: `/inbox/${ids.conversationId}` } } } } });
    expect(h.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'PUSH' }));
  });

  it('serializes simultaneous messages and ignores stale revisions and duplicate messages', async () => {
    const h = worker();
    const newer = payload({ revision: '2000', unreadCount: '2', messageTimestamp: '2000' });
    await Promise.all([h.push(payload()), h.push(newer)]);
    await h.push(payload()); await h.push(newer);
    expect(h.visible).toHaveLength(1);
    expect(h.showNotification).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer preview when an older WhatsApp event has a newer unread snapshot', async () => {
    const h = worker();
    await h.push(payload({ revision: '2000', messageTimestamp: '2000', messagePreview: 'الأحدث' }));
    await h.push(payload({ revision: '3000', messageTimestamp: '1000', unreadCount: '3', messagePreview: 'القديم' }));
    expect(h.visible[0]).toMatchObject({ title: 'علي (3)', options: { body: 'الأحدث' } });
  });

  it('does not decrease the count when concurrent database snapshots have the same millisecond revision', async () => {
    const h = worker();
    await h.push(payload({ unreadCount: '2', messageId: '507f1f77bcf86cd799439016', messagePreview: 'الأحدث' }));
    await h.push(payload({ unreadCount: '1' }));
    expect(h.visible[0]).toMatchObject({ title: 'علي (2)', options: { body: 'الأحدث' } });
  });

  it('isolates conversations, tenants, accounts and recipients and closes only the requested recipient/chat', async () => {
    const h = worker();
    await h.push(payload());
    for (const key of ['tenantId', 'accountId', 'recipientId', 'conversationId']) {
      await h.push(payload({ [key]: '507f1f77bcf86cd799439020' }));
    }
    expect(h.visible).toHaveLength(5);
    await h.close({ tenantId: ids.tenantId, recipientId: ids.recipientId, accountId: ids.accountId, conversationId: ids.conversationId });
    expect(h.visible).toHaveLength(4);
    await h.close({ tenantId: ids.tenantId, recipientId: ids.recipientId });
    expect(h.visible).toHaveLength(2);
  });

  it('closes a queued display after a chat is read and resets to a first notification on the next unread message', async () => {
    const h = worker();
    await Promise.all([h.push(payload()), h.close({ tenantId: ids.tenantId, recipientId: ids.recipientId, conversationId: ids.conversationId })]);
    expect(h.visible).toHaveLength(0);
    await h.push(payload({ revision: '3000', messageId: '507f1f77bcf86cd799439017' }));
    expect(h.visible[0]).toMatchObject({ title: 'علي', options: { silent: false } });
  });

  it('accepts notification-data metadata, while leaving calls and malformed/legacy pushes to Angular', async () => {
    const h = worker();
    const message = payload();
    await h.push({ notification: { ...message.notification, data: { halaMessage: message.data } } });
    expect(h.visible).toHaveLength(1);
    expect(await h.push({ notification: { title: 'مكالمة واردة' }, data: { type: 'call.incoming' } })).not.toHaveBeenCalled();
    expect(await h.push(payload({ recipientId: 'invalid' }))).not.toHaveBeenCalled();
    expect(h.showNotification).toHaveBeenCalledOnce();
  });

  it('reads compact FCM metadata without repeating title/body in the data payload', async () => {
    const h = worker();
    await h.push({ notification: { title: 'علي (2)', body: 'آخر رسالة' }, data: { ...ids,
      groupingVersion: '1', unreadCount: '2', revision: '1000', messageTimestamp: '1000', icon: '/photo' } });
    expect(h.visible[0]).toMatchObject({ title: 'علي (2)', options: { body: 'آخر رسالة', icon: '/photo' } });
  });
});
