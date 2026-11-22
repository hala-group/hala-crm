import { expect, test, type Page } from '@playwright/test';

const accountId = '507f1f77bcf86cd799439011';
async function openAccounts(page: Page, canDelete: boolean) {
  let account: Record<string, unknown> | null = { _id: accountId, tenantId: '507f1f77bcf86cd799439014',
    label: 'رقم التجربة', provider: 'baileys', status: 'disconnected', desiredState: 'disconnected', capabilities: ['text'] };
  await page.route('**/socket.io/**', route => route.abort());
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    let body: unknown = {};
    if (path === '/auth/refresh') body = { accessToken: 'cleanup-layout-test', expiresIn: 900 };
    else if (path === '/me') body = { id: '507f1f77bcf86cd799439013', tenantId: '507f1f77bcf86cd799439014',
      name: 'مدير', status: 'active', email: 'cleanup@example.test', accountMemberships: [],
      role: { id: '507f1f77bcf86cd799439015', name: 'Manager', permissions: ['accounts:read', 'accounts:update', 'accounts:create',
        'accounts:access_all', ...(canDelete ? ['accounts:delete'] : [])] } };
    else if (path === '/users') body = [];
    else if (path === '/whatsapp/accounts') body = account ? [account] : [];
    else if (route.request().method() === 'DELETE') {
      if (path.endsWith('/chats')) expect(route.request().postDataJSON()).toEqual({ confirm: true });
      const cleanup = { id: 'cleanup-job', operation: canDelete ? 'delete' : 'clear', state: 'queued', processedMedia: 0, totalMedia: 100 };
      account = { ...account, cleanup };
      return route.fulfill({ status: 202, json: { accepted: true, cleanup } });
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/accounts');
  await expect(page.locator('.account-card')).toHaveCount(1);
  return { finish: () => { account = canDelete ? null : { ...account, cleanup: undefined, status: 'connecting' }; } };
}

test('account cleanup retains its card and shows progress until deletion completes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await openAccounts(page, true);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'المزيد من الإجراءات' }).click();
  await page.getByRole('button', { name: 'حذف الرقم نهائياً' }).click();
  await expect(page.getByText('جارٍ حذف الرقم وبياناته…', { exact: false })).toBeVisible();
  await expect(page.locator('.account-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'المزيد من الإجراءات' })).toBeDisabled();
  state.finish();
  await expect(page.locator('.account-card')).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByText('تم حذف الرقم «رقم التجربة» وبياناته بنجاح.')).toBeVisible();
});

test('account cleanup clears a disconnected account using update permission and waits before announcing QR readiness', async ({ page }) => {
  const state = await openAccounts(page, false);
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'المزيد من الإجراءات' }).click();
  await page.getByRole('button', { name: 'مسح الدردشات وإعادة الربط' }).click();
  await expect(page.getByText('جارٍ مسح الدردشات…', { exact: false })).toBeVisible();
  await expect(page.getByText('اكتمل مسح الدردشات.', { exact: false })).toHaveCount(0);
  state.finish();
  await expect(page.getByText('اكتمل مسح الدردشات. امسح رمز QR لربط الرقم من جديد.')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.account-card')).toHaveCount(1);
});
