import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-ez1.4: three failed sign-ins lock a Canvas-password account until an admin unlocks it;
 * the audit log records it. Serial: the steps share the account the first one locks.
 */
test.describe.configure({ mode: 'serial', timeout: 60_000 });

const RUN = Date.now();
const LOCKED_EMAIL = `e2e-user-${RUN}-locked@example.com`;
const CHANGER_EMAIL = `e2e-user-${RUN}-changer@example.com`;
const WRONG = 'definitely-not-it-9';

let adminCtx: BrowserContext;
let adminPage: Page;
let lockedId = '';
let lockedPassword = '';
let changerPassword = '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

async function createUser(email: string) {
  const res = await adminPage.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name: `E2E ${email}`, role: 'architect' } });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.user.id as string, password: body.temporaryPassword as string };
}

async function audit(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  adminPage = await adminCtx.newPage();
  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expectSignedIn(adminPage);
  ({ id: lockedId, password: lockedPassword } = await createUser(LOCKED_EMAIL));
  ({ password: changerPassword } = await createUser(CHANGER_EMAIL));
});

test.afterAll(async () => {
  await adminCtx?.close();
});

test('three failed sign-ins lock the account, even for the correct password', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('login-email').fill(LOCKED_EMAIL);
    await page.getByTestId('login-password').fill(WRONG);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page.getByTestId('login-error')).not.toContainText(/locked/i);
  }
  await page.getByTestId('login-password').fill(WRONG);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText(/locked/i);

  await page.getByTestId('login-password').fill(lockedPassword);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText(/locked/i);
  await expect(page.getByTestId('sign-out')).toHaveCount(0);
  await ctx.close();
});

test('the Users page shows a Locked badge; the page has no axe violations', async () => {
  await adminPage.goto('/?admin=users');
  await expect(adminPage.getByTestId(`user-locked-${lockedId}`)).toBeVisible();
  await expect(adminPage.getByTestId(`unlock-${lockedId}`)).toBeVisible();
  await audit(adminPage);
});

test('Unlock removes the badge and the user can sign in again', async ({ browser }) => {
  await adminPage.goto('/?admin=users');
  await adminPage.getByTestId(`unlock-${lockedId}`).click();
  await expect(adminPage.getByTestId(`user-locked-${lockedId}`)).toHaveCount(0);
  await expect(adminPage.getByTestId(`unlock-${lockedId}`)).toHaveCount(0);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, LOCKED_EMAIL, lockedPassword);
  // It is still a one-time password, so the forced change comes next.
  await expect(page.getByTestId('change-password-page')).toBeVisible();
  await ctx.close();
});

test('View activity shows the failed sign-ins, lock and unlock in plain language', async () => {
  await adminPage.goto('/?admin=users');
  await adminPage.getByTestId(`view-activity-${lockedId}`).click();
  await expect(adminPage.getByTestId('audit-log')).toBeVisible();
  expect(adminPage.url()).toContain(`userId=${lockedId}`);

  const rows = adminPage.locator('[data-testid^="audit-row-"]');
  await expect(rows.filter({ hasText: 'Failed sign-in (wrong password)' })).toHaveCount(3);
  await expect(rows.filter({ hasText: 'Failed sign-in (account locked)' })).toHaveCount(1);
  await expect(rows.filter({ has: adminPage.getByRole('cell', { name: 'Account locked', exact: true }) })).toHaveCount(1);
  await expect(rows.filter({ has: adminPage.getByRole('cell', { name: 'Account unlocked', exact: true }) })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Signed in' })).toHaveCount(1);
  await expect(adminPage.getByTestId('audit-load-older')).toHaveCount(0);
  await expect(rows.filter({ has: adminPage.getByRole('cell', { name: 'Account unlocked', exact: true }) })).toContainText(ADMIN_EMAIL);
});

test('the Audit log page has no axe violations and fits a 390px screen', async () => {
  await adminPage.goto('/?admin=audit');
  await expect(adminPage.getByTestId('audit-log')).toBeVisible();
  await audit(adminPage);

  await adminPage.setViewportSize({ width: 390, height: 844 });
  await expect(adminPage.getByTestId('audit-log')).toBeVisible();
  const { scrollWidth, clientWidth } = await adminPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  await adminPage.setViewportSize({ width: 1280, height: 720 });
});

test('wrong current password until locked on the change-password page ends the session', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, CHANGER_EMAIL, changerPassword);
  await expect(page.getByTestId('change-password-page')).toBeVisible();

  for (let i = 0; i < 2; i++) {
    await page.getByTestId('change-password-current').fill(WRONG);
    await page.getByTestId('change-password-new').fill('Zebra-lantern-quartz-42');
    await page.getByTestId('change-password-confirm').fill('Zebra-lantern-quartz-42');
    await page.getByTestId('change-password-submit').click();
    await expect(page.getByTestId('change-password-error')).toContainText(/incorrect/i);
  }
  await page.getByTestId('change-password-current').fill(WRONG);
  await page.getByTestId('change-password-submit').click();
  await expect(page.getByTestId('change-password-error')).toContainText(/locked/i);

  await page.getByTestId('change-password-sign-in-again').click();
  await expect(page.getByTestId('login-email')).toBeVisible();
  await ctx.close();
});
