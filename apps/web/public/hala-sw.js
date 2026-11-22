/* Claim only Hala message push before Angular installs its default display listener. */
(() => {
  'use strict';
  const pending = new Map();
  const identity = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
  const tagFor = meta => `message:${meta.tenantId}:${meta.accountId}:${meta.recipientId}:${meta.conversationId}`;
  const titleFor = (title, count) => count > 1 ? `${title} (${count})` : title;

  function metadata(payload) {
    const meta = payload?.notification?.data?.halaMessage ?? payload?.data;
    if (meta?.groupingVersion !== '1' || !['tenantId', 'accountId', 'recipientId', 'conversationId', 'messageId'].every(key => identity(meta[key]))) return null;
    const unreadCount = Number(meta.unreadCount);
    const revision = Number(meta.revision);
    const messageTimestamp = Number(meta.messageTimestamp);
    const suffix = ` (${unreadCount})`;
    const title = payload.notification?.title;
    const senderTitle = meta.senderTitle ?? (unreadCount > 1 && title?.endsWith(suffix) ? title.slice(0, -suffix.length) : title);
    const messagePreview = meta.messagePreview ?? payload.notification?.body;
    if (!Number.isSafeInteger(unreadCount) || unreadCount < 1 || !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(messageTimestamp) || messageTimestamp < 1 || typeof senderTitle !== 'string' || typeof messagePreview !== 'string') return null;
    return { ...meta, unreadCount, revision, messageTimestamp, senderTitle, messagePreview,
      icon: meta.icon ?? payload.data?.icon ?? payload.notification?.icon };
  }

  function enqueue(tag, operation) {
    const next = (pending.get(tag) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(tag, next);
    void next.finally(() => { if (pending.get(tag) === next) pending.delete(tag); }).catch(() => {});
    return next;
  }

  async function display(payload, meta) {
    const tag = tagFor(meta);
    const notifications = await self.registration.getNotifications();
    const previous = notifications.filter(notification => notification.tag === tag || notification.tag === `message:${meta.conversationId}`);
    const current = previous.map(notification => notification.data?.halaMessage)
      .filter(value => value && value.recipientId === meta.recipientId && value.tenantId === meta.tenantId && value.accountId === meta.accountId)
      .sort((a, b) => b.revision - a.revision || b.messageTimestamp - a.messageTimestamp)[0];
    if (current && (current.revision > meta.revision ||
      (current.revision === meta.revision && current.messageId === meta.messageId))) return;
    // A later database snapshot can describe an older event. Update its count without rolling the preview back.
    const keepPreview = current && (current.messageTimestamp > meta.messageTimestamp ||
      (current.messageTimestamp === meta.messageTimestamp && current.messageId > meta.messageId));
    const unreadCount = current?.revision === meta.revision ? Math.max(current.unreadCount, meta.unreadCount) : meta.unreadCount;
    const summary = keepPreview ? { ...meta, unreadCount, senderTitle: current.senderTitle, messagePreview: current.messagePreview,
      icon: current.icon, messageTimestamp: current.messageTimestamp, messageId: current.messageId } : { ...meta, unreadCount };
    const url = `/inbox/${meta.conversationId}`;
    for (const notification of previous) notification.close();
    await self.registration.showNotification(titleFor(summary.senderTitle, unreadCount), {
      body: summary.messagePreview, icon: summary.icon ?? payload.notification?.icon ?? '/assets/imgs/logo.webp',
      tag, renotify: false, silent: previous.length > 0, timestamp: summary.messageTimestamp,
      data: { halaMessage: summary, onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } }
    });
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'PUSH', data: payload });
  }

  self.addEventListener('push', event => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    const meta = metadata(payload);
    if (!meta || typeof self.registration.getNotifications !== 'function') return; // Calls and older clients retain Angular's normal behavior.
    event.stopImmediatePropagation();
    event.waitUntil(enqueue(tagFor(meta), () => display(payload, meta)));
  });

  self.addEventListener('message', event => {
    const message = event.data;
    if (message?.type !== 'HALA_CLOSE_MESSAGE_NOTIFICATIONS' || !identity(message.tenantId) || !identity(message.recipientId)) return;
    if (message.conversationId !== undefined && !identity(message.conversationId)) return;
    if (message.accountId !== undefined && !identity(message.accountId)) return;
    event.waitUntil((async () => {
      const notifications = await self.registration.getNotifications();
      const tags = new Set([...pending.keys(), ...notifications.map(notification => notification.tag)]);
      const matching = [...tags].filter(tag => {
        const parts = tag.split(':');
        return parts[0] === 'message' && parts[1] === message.tenantId && parts[3] === message.recipientId &&
          (!message.accountId || parts[2] === message.accountId) &&
          (!message.conversationId || parts[4] === message.conversationId);
      });
      await Promise.all(matching.map(tag => enqueue(tag, async () => {
        for (const notification of await self.registration.getNotifications({ tag })) notification.close();
      })));
    })());
  });
})();

// Preserve Angular caching, updates, call notifications and notification-click navigation in this registration.
importScripts('./ngsw-worker.js');
