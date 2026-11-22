import { expect, test } from '@playwright/test';

test('built service worker groups message push, updates silently and closes only the read chat', async ({ page, context, baseURL }) => {
  test.skip(!baseURL, 'Requires a production web build with service workers enabled');
  const origin = new URL(baseURL!).origin;
  await context.grantPermissions(['notifications'], { origin });
  await page.route('**/push-harness', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Push worker check</title>' }));
  await page.goto(`${origin}/push-harness`);
  const cdp = await context.newCDPSession(page);
  let registrationId = '';
  cdp.on('ServiceWorker.workerRegistrationUpdated', event => {
    const registration = event.registrations.find(item => item.scopeURL === `${origin}/` && !item.isDeleted);
    if (registration) registrationId = registration.registrationId;
  });
  await cdp.send('ServiceWorker.enable');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/hala-sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => registrationId).not.toBe('');
  const ids = { tenantId: '507f1f77bcf86cd799439011', accountId: '507f1f77bcf86cd799439012',
    recipientId: '507f1f77bcf86cd799439013', conversationId: '507f1f77bcf86cd799439014', messageId: '507f1f77bcf86cd799439015' };
  const send = async (overrides = {}) => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId,
    data: JSON.stringify({ notification: { title: 'اختبار إشعارات', body: 'رسالة اختبار' }, data: {
      ...ids, groupingVersion: '1', senderTitle: 'اختبار إشعارات', messagePreview: 'رسالة اختبار', unreadCount: '1',
      revision: '1000', messageTimestamp: '1000', ...overrides
    } }) });
  const notifications = () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.getNotifications()).map(item => ({ title: item.title, body: item.body, tag: item.tag, silent: item.silent }));
  });
  try {
    await send();
    await expect.poll(notifications).toHaveLength(1);
    await send({ unreadCount: '2', revision: '2000', messageTimestamp: '2000', messageId: '507f1f77bcf86cd799439016', messagePreview: 'آخر رسالة اختبار' });
    await expect.poll(notifications).toEqual([expect.objectContaining({ title: 'اختبار إشعارات (2)', body: 'آخر رسالة اختبار', silent: true })]);
    await send({ conversationId: '507f1f77bcf86cd799439020' });
    await expect.poll(notifications).toHaveLength(2);
    await page.evaluate(async data => {
      const registration = await navigator.serviceWorker.ready;
      registration.active!.postMessage({ type: 'HALA_CLOSE_MESSAGE_NOTIFICATIONS', ...data });
    }, { tenantId: ids.tenantId, accountId: ids.accountId, recipientId: ids.recipientId, conversationId: ids.conversationId });
    await expect.poll(notifications).toEqual([expect.objectContaining({ tag: `message:${ids.tenantId}:${ids.accountId}:${ids.recipientId}:507f1f77bcf86cd799439020` })]);
  } finally {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      for (const notification of await registration.getNotifications()) notification.close();
      await registration.unregister();
    });
    await cdp.detach();
  }
});
