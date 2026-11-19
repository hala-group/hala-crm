import { expect, test, type Page } from '@playwright/test';

const accountId = '507f1f77bcf86cd799439011';
const secondAccountId = '507f1f77bcf86cd799439012';
const providerCapabilities = ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location',
  'contacts', 'reaction', 'poll', 'reply', 'mentions', 'edit', 'revoke', 'forward'];
const accounts = [
  { _id: accountId, label: 'رقم المبيعات', phoneNumber: '+201000000001', color: '#0284c7', status: 'connected', capabilities: providerCapabilities },
  { _id: secondAccountId, label: 'خدمة العملاء', phoneNumber: '+201000000002', color: '#9333ea', status: 'connected', capabilities: providerCapabilities }
];

async function openInbox(page: Page, viewer = false, includeTimelineMessages = false) {
  await page.route('**/socket.io/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    let body: unknown = {};
    if (path === '/auth/refresh') body = { accessToken: 'isolated-layout-test', expiresIn: 900 };
    else if (path === '/me') body = { id: '507f1f77bcf86cd799439013', tenantId: '507f1f77bcf86cd799439014',
      name: 'مالك النظام', email: 'layout@example.test', status: 'active',
      role: { id: '507f1f77bcf86cd799439015', name: viewer ? 'Viewer' : 'Owner',
        permissions: viewer ? ['conversations:read', 'calls:read'] : ['conversations:read', 'conversations:read_all',
          'conversations:archive', 'contacts:read', 'accounts:access_all', 'accounts:create', 'users:read', 'calls:read', 'messages:send'] },
      accountMemberships: [{ accountId, level: viewer ? 'view' : 'manage' }] };
    else if (path === '/whatsapp/accounts') body = viewer ? accounts.slice(0, 1) : accounts;
    else if (path === '/tags') body = { tags: [] };
    else if (path === '/calls') body = [];
    else if (path === '/message-push/config') body = { enabled: false };
    else if (path === '/conversations') {
      const selected = url.searchParams.get('accountId');
      body = { nextCursor: null, items: Array.from({ length: 16 }, (_, index) => ({
        _id: `607f1f77bcf86cd7994390${String(index).padStart(2, '0')}`, tenantId: '507f1f77bcf86cd799439014',
        accountId: selected || (index % 2 ? secondAccountId : accountId), contactId: '707f1f77bcf86cd799439011',
        contactName: index === 0 ? 'أحمد محمد' : index === 1 ? '+201000000000' : `عميل تجريبي ${index}`,
        contactWaId: '201000000000@s.whatsapp.net',
        status: 'open', lastMessageAt: '2026-11-19T08:00:00Z', lastMessagePreview: 'مرحباً، أريد الاستفسار عن الطلب',
        lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: index % 3 ? 0 : 2
      })) };
    } else if (path.endsWith('/profile/refresh')) {
      body = { _id: path.split('/')[2], tenantId: '507f1f77bcf86cd799439014', accountId,
        contactId: '707f1f77bcf86cd799439011', contactName: 'أحمد محمد', contactWaId: '201000000000@s.whatsapp.net',
        status: 'open', lastMessageAt: '2026-11-19T08:00:00Z', lastMessagePreview: 'مرحباً، أريد الاستفسار عن الطلب',
        lastMessageType: 'text', lastMessageDirection: 'in', unreadCount: 0 };
    } else if (/^\/conversations\/[^/]+\/messages$/.test(path)) {
      if (!includeTimelineMessages) body = { items: [], nextCursor: null };
      else {
        const now = new Date();
        const todayAtNine = new Date(now); todayAtNine.setHours(9, 0, 0, 0);
        const todayAtEight = new Date(now); todayAtEight.setHours(8, 0, 0, 0);
        const yesterdayAtNine = new Date(now); yesterdayAtNine.setDate(now.getDate() - 1); yesterdayAtNine.setHours(21, 0, 0, 0);
        const conversationId = path.split('/')[2]!;
        body = { nextCursor: null, items: [
          { _id: '807f1f77bcf86cd799439003', waMessageId: 'today-late', timestamp: todayAtNine.toISOString(), text: 'رسالة اليوم الثانية', forwarded: true },
          { _id: '807f1f77bcf86cd799439002', waMessageId: 'today-early', timestamp: todayAtEight.toISOString(), text: 'رسالة اليوم الأولى' },
          { _id: '807f1f77bcf86cd799439001', waMessageId: 'yesterday', timestamp: yesterdayAtNine.toISOString(), text: 'رسالة الأمس' }
        ].map(message => ({ ...message, tenantId: '507f1f77bcf86cd799439014', accountId, conversationId,
          contactId: '707f1f77bcf86cd799439011', direction: 'in', type: 'text', status: 'delivered' })) };
      }
    }
    else if (path.includes('/avatar')) return route.fulfill({ status: 404 });
    await route.fulfill({ json: body });
  });
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'البريد الوارد' })).toBeVisible();
  await expect(page.locator('.conversation').first()).toBeVisible();
}

for (const width of [320, 390, 720]) {
  test(`compact inbox fits a ${width}px screen and keeps search beside new chat`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openInbox(page);
    await expect(page.getByRole('button', { name: 'فتح قائمة التنقل' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'التنقل الرئيسي', exact: true })).toBeHidden();
    const search = await page.getByRole('textbox', { name: 'بحث', exact: true }).boundingBox();
    const newChat = await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).boundingBox();
    expect(search).not.toBeNull(); expect(newChat).not.toBeNull();
    expect(Math.abs(search!.y - newChat!.y)).toBeLessThan(2);
    expect(newChat!.width).toBeGreaterThanOrEqual(44);
    expect(await page.locator('.new-chat-toggle span').isVisible()).toBe(false);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      list: document.querySelector('.conversations')!.getBoundingClientRect().toJSON() }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(width);
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
    expect(dimensions.list.height).toBeGreaterThan(550);
    if (width === 390) await page.screenshot({ path: '.tmp/mobile-inbox-390.png', fullPage: true });
    await page.getByRole('button', { name: 'محادثة جديدة', exact: true }).click();
    await expect(page.getByLabel('رقم الإرسال')).toBeVisible();
    await expect(page.getByRole('button', { name: 'محادثة جديدة', exact: true })).toHaveAttribute('aria-expanded', 'true');
  });
}

test('conversation actions are grouped in the three-dot menu and restore focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  await page.locator('.conversation').first().click();

  const trigger = page.locator('.thread-actions-menu summary');
  const panel = page.locator('.thread-actions-panel');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(panel.getByRole('button', { name: 'بحث في هذه المحادثة' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'أرشفة المحادثة' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /تحديد ك(?:مقروء|غير مقروء)/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'بيانات جهة الاتصال' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await panel.getByRole('button', { name: 'بيانات جهة الاتصال' }).click();
  await expect(page.locator('#contact-details')).toBeVisible();
  await page.locator('#contact-details').getByRole('button', { name: 'إغلاق بيانات جهة الاتصال' }).click();
  await expect(trigger).toBeFocused();
});

test('conversation action menu respects role permissions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page, true);
  await page.locator('.conversation').first().click();
  const trigger = page.locator('.thread-actions-menu summary');
  await trigger.click();
  const panel = page.locator('.thread-actions-panel');
  await expect(panel.getByRole('button', { name: 'بحث في هذه المحادثة' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /تحديد ك(?:مقروء|غير مقروء)/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'أرشفة المحادثة' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'بيانات جهة الاتصال' })).toHaveCount(0);
});

test('phone conversation names keep the plus sign before the digits in RTL', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);

  const phoneName = page.locator('.conversation-title-group strong').nth(1);
  await expect(phoneName).toHaveText('+201000000000');
  await expect(phoneName).toHaveAttribute('dir', 'auto');
  expect(await phoneName.evaluate(element => getComputedStyle(element).direction)).toBe('ltr');
  const characterPositions = await phoneName.evaluate(element => {
    const text = element.firstChild!;
    const plus = document.createRange();
    plus.setStart(text, 0);
    plus.setEnd(text, 1);
    const firstDigit = document.createRange();
    firstDigit.setStart(text, 1);
    firstDigit.setEnd(text, 2);
    return { plus: plus.getBoundingClientRect().left, firstDigit: firstDigit.getBoundingClientRect().left };
  });
  expect(characterPositions.plus).toBeLessThan(characterPositions.firstDigit);

  await page.locator('.conversation').nth(1).click();
  const threadPhoneName = page.locator('.thread-title h2');
  await expect(threadPhoneName).toHaveText('+201000000000');
  await expect(threadPhoneName).toHaveAttribute('dir', 'auto');
  expect(await threadPhoneName.evaluate(element => getComputedStyle(element).direction)).toBe('ltr');
});

test('message timeline groups messages under one WhatsApp-style day divider', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page, false, true);
  await page.locator('.conversation').first().click();

  const dividers = page.locator('.message-day-divider');
  await expect(dividers).toHaveCount(2);
  await expect(dividers.nth(0)).toHaveText('أمس');
  await expect(dividers.nth(1)).toHaveText('اليوم');
  await expect(page.locator('.message')).toHaveCount(3);
  await expect(page.getByRole('img', { name: 'رسالة محوّلة' })).toBeVisible();
  await expect(page.getByText('رسالة محوّلة', { exact: true })).toHaveCount(0);
});

test('mobile drawer traps focus, closes with Escape, backdrop and navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  const trigger = page.getByRole('button', { name: 'فتح قائمة التنقل' });
  const dialog = page.getByRole('dialog', { name: 'القائمة الرئيسية' });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('link', { name: 'الأرقام', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'إغلاق قائمة التنقل' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.locator('.search-box input').evaluate(input => (input as HTMLInputElement).focus());
  expect(await page.evaluate(() => document.querySelector('dialog')!.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: '.tmp/mobile-navigation-390.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.mouse.click(8, 400);
  await expect(dialog).toBeHidden();
  await trigger.click();
  await dialog.getByRole('link', { name: 'المحادثات', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('compact account picker keeps labels, phones, selection and filters working', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page);
  const selector = page.locator('.filter-select summary');
  expect((await selector.boundingBox())!.width).toBeLessThanOrEqual(44);
  await selector.click();
  const selected = page.locator('.filter-options').getByRole('button', { name: /رقم المبيعات/ });
  await expect(selected).toContainText('+201000000001');
  await page.screenshot({ path: '.tmp/mobile-accounts-390.png', fullPage: true });
  await Promise.all([
    page.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/conversations' && new URL(request.url()).searchParams.get('accountId') === accountId),
    selected.click()
  ]);
  await expect(selector).toHaveAccessibleName('تصفية حسب الرقم: رقم المبيعات');
  await expect(selector.locator('.account-color')).toHaveCSS('background-color', 'rgb(2, 132, 199)');
  await expect(selector).toBeFocused();
  await selector.click();
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.filter-options')).toBeHidden();
  await expect(selector).toBeFocused();
  await selector.click();
  await page.locator('.filter-options').getByRole('button', { name: 'كل الأرقام' }).click();
  await expect(selector).toHaveAccessibleName('تصفية حسب الرقم: كل الأرقام');
});

test('drawer respects user permissions and desktop keeps inline navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInbox(page, true);
  await page.getByRole('button', { name: 'فتح قائمة التنقل' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('link', { name: 'المحادثات', exact: true })).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'المستخدمون', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('link', { name: 'الأرقام', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'التنقل الرئيسي', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'فتح قائمة التنقل' })).toBeHidden();
});
