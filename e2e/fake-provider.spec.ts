import { expect, test } from '@playwright/test';

test('owner creates, connects and sends through FakeProvider in the browser', async ({ page, request }) => {
  const slug = process.env.E2E_TENANT_SLUG ?? 'e2e-company';
  const email = process.env.E2E_OWNER_EMAIL ?? 'owner@e2e.test';
  const password = process.env.E2E_OWNER_PASSWORD ?? 'e2e-password-123';
  const login = await request.post('/api/v1/auth/login', { data: { tenantSlug: slug, email, password } });
  expect(login.ok()).toBeTruthy();
  const { accessToken } = await login.json() as { accessToken: string };
  const headers = { Authorization: `Bearer ${accessToken}` };
  const label = `E2E ${Date.now()}`;
  const created = await request.post('/api/v1/whatsapp/accounts', { headers, data: { label } });
  expect(created.ok()).toBeTruthy();
  const account = await created.json() as { _id: string };
  const connected = await request.post(`/api/v1/whatsapp/accounts/${account._id}/connect`, { headers });
  expect(connected.ok()).toBeTruthy();
  await expect.poll(async () => {
    const result = await request.get(`/api/v1/whatsapp/accounts/${account._id}`, { headers });
    return (await result.json() as { status: string }).status;
  }, { timeout: 30_000 }).toBe('connected');
  const body = `FakeProvider message ${Date.now()}`;
  const sent = await request.post('/api/v1/messages', { headers, data: {
    accountId: account._id, to: '+201234567890', clientMessageId: crypto.randomUUID(), type: 'text', text: body
  } });
  expect(sent.ok()).toBeTruthy();
  await page.goto('/login');
  await page.getByLabel('معرّف الشركة').fill(slug);
  await page.getByLabel('البريد الإلكتروني').fill(email);
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.getByRole('link', { name: 'الأرقام' }).waitFor({ state: 'visible' });
  await page.getByRole('link', { name: 'الأرقام' }).click();
  await expect(page.getByText(label)).toBeVisible();
  await page.getByRole('link', { name: 'المحادثات' }).click();
  await expect(page.getByText(body)).toBeVisible({ timeout: 30_000 });
});
