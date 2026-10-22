import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { nextCode, wrongCode } from './totp-helper';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-ez1.5: voluntary two-step verification set-up, two-step sign-in with an authenticator code
 * and with a recovery code, and the admin's MFA reset. (The dev server is not in MFA-required
 * mode; forced enrolment is covered by the API contract tests.) Serial: steps share one account.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const EMAIL = `e2e-user-${RUN}-mfa@example.com`;
const PASSWORD = 'Zebra-lantern-quartz-42'; // gitleaks:allow

let adminCtx: BrowserContext;
let adminPage: Page;
let userCtx: BrowserContext;
let userPage: Page;
let userId = '';
let secret = '';
let lastStep = 0;
let recoveryCodes: string[] = [];

async function passwordSignIn(page: Page) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(EMAIL);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  adminPage = await adminCtx.newPage();
  await adminPage.goto('/');
  await adminPage.getByTestId('login-email').fill(ADMIN_EMAIL);
  await adminPage.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await adminPage.getByTestId('login-submit').click();
  await expectSignedIn(adminPage);

  const created = await adminPage.request.post(`${API_BASE_URL}/admin/users`, { data: { email: EMAIL, name: 'E2E MFA User', role: 'architect' } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  userId = body.user.id;

  // Settle the one-time password through the API so the UI steps start from a normal account.
  userCtx = await browser.newContext();
  const login = await userCtx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email: EMAIL, password: body.temporaryPassword } });
  expect(login.status()).toBe(200);
  const change = await userCtx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } });
  expect(change.status()).toBe(200);
  userPage = await userCtx.newPage();
});

test.afterAll(async () => {
  await adminCtx?.close();
  await userCtx?.close();
});

test('the user sets up two-step verification and saves the recovery codes', async () => {
  await userPage.goto('/');
  await expectSignedIn(userPage);
  await userPage.getByTestId('nav-change-password').click();
  await expect(userPage.getByTestId('change-password-page')).toBeVisible();

  await userPage.getByTestId('mfa-begin').click();
  await expect(userPage.getByTestId('mfa-qr')).toBeVisible();
  expect(((await userPage.getByTestId('mfa-qr').getAttribute('alt')) ?? '').length).toBeGreaterThan(10);
  secret = ((await userPage.getByTestId('mfa-secret').textContent()) ?? '').replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);

  await userPage.getByTestId('mfa-confirm-code').fill(wrongCode(secret));
  await userPage.getByTestId('mfa-confirm-submit').click();
  await expect(userPage.getByTestId('mfa-error')).toBeVisible();

  const { code, step } = await nextCode(secret, lastStep);
  lastStep = step;
  await userPage.getByTestId('mfa-confirm-code').fill(code);
  await userPage.getByTestId('mfa-confirm-submit').click();

  const items = userPage.getByTestId('mfa-recovery-codes').locator('li');
  await expect(items).toHaveCount(10);
  recoveryCodes = (await items.allTextContents()).map((t) => t.trim());
  for (const c of recoveryCodes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

  await expect(userPage.getByTestId('mfa-done')).toBeDisabled();
  await userPage.getByTestId('mfa-recovery-saved').check();
  await expect(userPage.getByTestId('mfa-done')).toBeEnabled();
  await userPage.getByTestId('mfa-done').click();
  await expect(userPage.getByTestId('mfa-status')).toContainText(/on/i);
});

test('sign-in now asks for a code; a wrong one is refused, the right one signs in', async () => {
  await userPage.getByTestId('sign-out').click();
  await expect(userPage.getByTestId('login-email')).toBeVisible();

  await passwordSignIn(userPage);
  await expect(userPage.getByTestId('mfa-code')).toBeVisible();
  await expect(userPage.getByTestId('nav-projects')).toHaveCount(0);
  await expect(userPage.getByTestId('sign-out')).toHaveCount(0);

  await userPage.getByTestId('mfa-code').fill(wrongCode(secret));
  await userPage.getByTestId('mfa-submit').click();
  await expect(userPage.getByTestId('login-error')).toBeVisible();
  await expect(userPage.getByTestId('mfa-code')).toBeVisible();

  const { code, step } = await nextCode(secret, lastStep);
  lastStep = step;
  await userPage.getByTestId('mfa-code').fill(code);
  await userPage.getByTestId('mfa-submit').click();
  await expectSignedIn(userPage);
  await expect(userPage.getByTestId('nav-projects')).toBeVisible();
});

test('a recovery code signs in once and reports how many are left', async () => {
  await userPage.getByTestId('sign-out').click();
  await passwordSignIn(userPage);
  await userPage.getByTestId('mfa-code').fill(recoveryCodes[0]);
  await userPage.getByTestId('mfa-submit').click();
  await expect(userPage.getByTestId('recovery-codes-remaining')).toContainText('9');
  await userPage.getByTestId('mfa-continue').click();
  await expectSignedIn(userPage);

  await userPage.getByTestId('sign-out').click();
  await passwordSignIn(userPage);
  await userPage.getByTestId('mfa-code').fill(recoveryCodes[0]);
  await userPage.getByTestId('mfa-submit').click();
  await expect(userPage.getByTestId('login-error')).toBeVisible();
  await expect(userPage.getByTestId('sign-out')).toHaveCount(0);
});

test('the code step has no axe violations', async () => {
  // userPage is on the code step, after the refused recovery code.
  await expect(userPage.getByTestId('mfa-code')).toBeVisible();
  await a11y(userPage);
});

test('the admin sees MFA on, resets it, and the user then signs in with the password alone', async () => {
  await adminPage.goto('/?admin=users');
  await expect(adminPage.getByTestId(`user-mfa-${userId}`)).toContainText(/on/i);
  await adminPage.getByTestId(`reset-mfa-${userId}`).click();
  await adminPage.getByTestId('confirm-reset-mfa').click();
  await expect(adminPage.getByTestId(`user-mfa-${userId}`)).not.toContainText(/^\s*on\s*$/i);
  await expect(adminPage.getByTestId(`reset-mfa-${userId}`)).toHaveCount(0);

  await passwordSignIn(userPage);
  await expectSignedIn(userPage);
  await expect(userPage.getByTestId('mfa-code')).toHaveCount(0);
});

test('the set-up page (QR step) has no axe violations and fits a 390px screen', async () => {
  await userPage.getByTestId('nav-change-password').click();
  await userPage.getByTestId('mfa-begin').click();
  await expect(userPage.getByTestId('mfa-qr')).toBeVisible();
  await a11y(userPage);

  await userPage.setViewportSize({ width: 390, height: 844 });
  await expect(userPage.getByTestId('mfa-qr')).toBeVisible();
  const { scrollWidth, clientWidth } = await userPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
});
