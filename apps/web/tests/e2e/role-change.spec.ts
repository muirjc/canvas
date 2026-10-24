import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-18c: changing a role signs that user out (their session held the old role), the last
 * active admin cannot be demoted or deactivated, and changing your own role lands you on sign-in.
 * Serial: the last-admin case must run before any throwaway admin exists.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const PASSWORD = 'Zebra-lantern-quartz-42'; // gitleaks:allow

let adminCtx: BrowserContext;
let admin: Page;
let adminId = '';
let otherAdmins: { id: string; email: string; active: boolean }[] = [];

async function createUser(email: string, role: 'admin' | 'architect') {
  const res = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name: `E2E ${email}`, role } });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.user.id as string, otp: body.temporaryPassword as string };
}

/** A throwaway admin: password settled through the API, then signed in through the UI. */
async function signedInThrowawayAdmin(browser: Browser, suffix: string) {
  const email = `e2e-user-${RUN}-${suffix}@example.com`;
  const { id, otp } = await createUser(email, 'admin');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  expect((await ctx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email, password: otp } })).status()).toBe(200);
  expect((await ctx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: otp, newPassword: PASSWORD } })).status()).toBe(200);
  const page = await ctx.newPage();
  await page.goto('/');
  await expectSignedIn(page);
  return { id, email, ctx, page };
}

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill(ADMIN_EMAIL);
  await admin.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);
  adminId = (await (await admin.request.get(`${API_BASE_URL}/auth/me`)).json()).user.id;

  // Leftover throwaway admins from earlier runs would make the seeded admin "not the last": retire them.
  const users = (await (await admin.request.get(`${API_BASE_URL}/admin/users`)).json()).users as { id: string; email: string; role: string; active: boolean }[];
  otherAdmins = users.filter((u) => u.role === 'admin' && u.active && u.id !== adminId);
  for (const u of otherAdmins.filter((o) => o.email.startsWith('e2e-user-'))) {
    await admin.request.patch(`${API_BASE_URL}/admin/users/${u.id}`, { data: { active: false } });
  }
  otherAdmins = otherAdmins.filter((o) => !o.email.startsWith('e2e-user-'));
});

test.afterAll(async () => {
  // Never leave the seeded admin demoted or deactivated.
  const res = await admin.request.patch(`${API_BASE_URL}/admin/users/${adminId}`, { data: { role: 'admin', active: true } });
  expect(res.status()).toBe(200);
  await adminCtx?.close();
});

test('the last active admin cannot be demoted or deactivated from the Users page', async () => {
  test.skip(otherAdmins.length > 0, 'the dev database has another real active admin, so the seeded admin is not the last one');
  await admin.goto('/?admin=users');
  const role = admin.getByTestId(`user-role-${adminId}`);
  await expect(role).toHaveValue('admin');

  await role.selectOption('architect');
  const error = admin.getByTestId('user-update-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/only active admin/i);
  await expect(role).toHaveValue('admin'); // the control reverts
  await expect(admin.getByTestId('sign-out')).toBeVisible(); // and nobody was signed out
  await a11y(admin); // with the error shown

  await admin.getByTestId(`user-active-${adminId}`).click(); // controlled by the server round trip, so not uncheck()
  await expect(admin.getByTestId('user-update-error')).toContainText(/only active admin/i);
  await expect(admin.getByTestId(`user-active-${adminId}`)).toBeChecked();
});

test('demoting a signed-in admin signs them out; signing in again they have no Admin link', async ({ browser }) => {
  const target = await signedInThrowawayAdmin(browser, 'demoted');
  await expect(target.page.getByTestId('nav-admin')).toBeVisible();

  await admin.goto('/?admin=users');
  await expect(admin.locator('p', { hasText: /signs them out/i })).toBeVisible();
  await admin.getByTestId(`user-role-${target.id}`).selectOption('architect');
  await expect(admin.getByTestId(`user-role-${target.id}`)).toHaveValue('architect');
  await expect(admin.getByTestId('user-update-error')).toHaveCount(0);

  // Their very next navigation lands on sign-in: the old admin session is gone.
  await target.page.goto('/');
  await expect(target.page.getByTestId('login-email')).toBeVisible();
  await expect(target.page.getByTestId('sign-out')).toHaveCount(0);

  await target.page.getByTestId('login-email').fill(target.email);
  await target.page.getByTestId('login-password').fill(PASSWORD);
  await target.page.getByTestId('login-submit').click();
  await expectSignedIn(target.page);
  await expect(target.page.getByTestId('nav-admin')).toHaveCount(0);
  await target.ctx.close();
});

test('changing your own role reloads to the sign-in screen', async ({ browser }) => {
  const self = await signedInThrowawayAdmin(browser, 'self');
  await self.page.goto('/?admin=users');
  const role = self.page.getByTestId(`user-role-${self.id}`);
  await expect(role).toHaveValue('admin');
  await role.selectOption('architect');
  await expect(self.page.getByTestId('login-email')).toBeVisible();
  await expect(self.page.getByTestId('sign-out')).toHaveCount(0);

  // They really were demoted.
  const users = (await (await admin.request.get(`${API_BASE_URL}/admin/users`)).json()).users as { id: string; role: string }[];
  expect(users.find((u) => u.id === self.id)?.role).toBe('architect');
  await self.ctx.close();
});
