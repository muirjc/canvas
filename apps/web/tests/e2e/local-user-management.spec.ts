import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-ez1.2: admin adds a user (one-time password), the user must change it at first sign-in,
 * can change it again voluntarily, and an admin reset signs them out and forces another change.
 * Serial: each step builds on the account the first one creates.
 */
test.describe.configure({ mode: 'serial', timeout: 60_000 });

const RUN = Date.now();
const EMAIL = `e2e-user-${RUN}@example.com`;
const NAME = `E2E User ${RUN}`;
const PASSWORD_1 = 'Zebra-lantern-quartz-42';
const PASSWORD_2 = 'Marble-harbour-violin-77';
const OTP = /^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$/;

let oneTimePassword = '';
let userId = '';
let adminCtx: BrowserContext;
let adminPage: Page;
let userCtx: BrowserContext;
let userPage: Page;

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

async function forcedChange(page: Page, current: string, next: string) {
  await page.getByTestId('change-password-current').fill(current);
  await page.getByTestId('change-password-new').fill(next);
  await page.getByTestId('change-password-confirm').fill(next);
  await page.getByTestId('change-password-submit').click();
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  adminPage = await adminCtx.newPage();
  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expectSignedIn(adminPage);
});

test.afterAll(async () => {
  await adminCtx?.close();
  await userCtx?.close();
});

async function addUser(email: string, name: string) {
  await adminPage.getByTestId('users-add').click();
  await adminPage.getByTestId('add-user-email').fill(email);
  await adminPage.getByTestId('add-user-name').fill(name);
  await adminPage.getByTestId('add-user-role').selectOption('architect');
  await adminPage.getByTestId('add-user-submit').click();
}

test('admin adds a user and sees the one-time password once; duplicate email is rejected', async () => {
  await adminPage.goto('/?admin=users');
  await expect(adminPage.getByTestId('users-add')).toBeVisible();

  await addUser(EMAIL, NAME);
  const shown = adminPage.getByTestId('one-time-password');
  await expect(shown).toBeVisible();
  oneTimePassword = ((await shown.textContent()) ?? '').trim();
  expect(oneTimePassword).toMatch(OTP);

  await adminPage.getByTestId('one-time-password-done').click();
  await expect(adminPage.getByTestId('one-time-password-dialog')).toHaveCount(0);
  const row = adminPage.locator('tr', { hasText: EMAIL });
  await expect(row).toBeVisible();
  const testId = await row.getAttribute('data-testid');
  userId = testId!.replace('user-row-', '');
  expect(userId).toBeTruthy();

  await addUser(EMAIL.toUpperCase(), 'Duplicate');
  await expect(adminPage.getByTestId('add-user-error')).toBeVisible();
  await expect(adminPage.getByTestId('one-time-password-dialog')).toHaveCount(0);
  await adminPage.keyboard.press('Escape');
  await expect(adminPage.getByTestId('add-user-dialog')).toHaveCount(0);
});

test('the admin has no reset button on their own row', async () => {
  await adminPage.goto('/?admin=users');
  const own = adminPage.locator('tr', { hasText: ADMIN_EMAIL });
  await expect(own.first()).toBeVisible();
  await expect(own.locator('[data-testid^="reset-password-"]')).toHaveCount(0);
  await expect(adminPage.getByTestId(`reset-password-${userId}`)).toBeVisible();
});

test('first sign-in forces a password change; errors surface; a valid change lands in the app', async ({ browser }) => {
  userCtx = await browser.newContext();
  userPage = await userCtx.newPage();
  await signIn(userPage, EMAIL, oneTimePassword);

  await expect(userPage.getByTestId('change-password-page')).toBeVisible();
  await expect(userPage.getByTestId('nav-projects')).toHaveCount(0);
  await expect(userPage.getByTestId('nav-admin')).toHaveCount(0);

  // Client-side: too short, then mismatched.
  await forcedChange(userPage, oneTimePassword, 'short');
  await expect(userPage.getByTestId('change-password-error')).toContainText('at least 12');
  await userPage.getByTestId('change-password-new').fill(PASSWORD_1);
  await userPage.getByTestId('change-password-confirm').fill(PASSWORD_1 + 'x');
  await userPage.getByTestId('change-password-submit').click();
  await expect(userPage.getByTestId('change-password-error')).toContainText('do not match');

  // Server-side policy.
  await forcedChange(userPage, oneTimePassword, 'password1234');
  await expect(userPage.getByTestId('change-password-error')).toContainText(/too common/i);
  await expect(userPage.getByTestId('change-password-page')).toBeVisible();

  await forcedChange(userPage, oneTimePassword, PASSWORD_1);
  await expect(userPage.getByTestId('change-password-page')).toHaveCount(0);
  await expect(userPage.getByTestId('nav-projects')).toBeVisible();
  await expect(userPage.getByTestId('nav-admin')).toHaveCount(0);
});

test('signing out and back in with the new password skips the forced screen; the old one-time password is dead', async () => {
  await userPage.getByTestId('sign-out').click();
  await expect(userPage.getByTestId('login-email')).toBeVisible();

  await signIn(userPage, EMAIL, oneTimePassword);
  await expect(userPage.getByTestId('login-error')).toBeVisible();

  await signIn(userPage, EMAIL, PASSWORD_1);
  await expectSignedIn(userPage);
  await expect(userPage.getByTestId('change-password-page')).toHaveCount(0);
  await expect(userPage.getByTestId('nav-projects')).toBeVisible();
});

test('voluntary change from the header link', async () => {
  await userPage.getByTestId('nav-change-password').click();
  await expect(userPage.getByTestId('change-password-page')).toBeVisible();
  await forcedChange(userPage, PASSWORD_1, PASSWORD_2);
  await expect(userPage.getByTestId('change-password-success')).toBeVisible();
  await userPage.getByTestId('change-password-back').click();
  await expect(userPage.getByTestId('change-password-page')).toHaveCount(0);
});

test('admin reset signs the user out and forces another change', async () => {
  await adminPage.goto('/?admin=users');
  await adminPage.getByTestId(`reset-password-${userId}`).click();
  await adminPage.getByTestId('confirm-reset-password').click();
  const shown = adminPage.getByTestId('one-time-password');
  await expect(shown).toBeVisible();
  const reset = ((await shown.textContent()) ?? '').trim();
  expect(reset).toMatch(OTP);
  await adminPage.getByTestId('one-time-password-done').click();

  // The user's existing session is gone: a reload lands on the sign-in screen.
  await userPage.reload();
  await expect(userPage.getByTestId('login-email')).toBeVisible();

  // Old password stops working, the new one-time password forces the change again.
  await signIn(userPage, EMAIL, PASSWORD_2);
  await expect(userPage.getByTestId('login-error')).toBeVisible();
  await signIn(userPage, EMAIL, reset);
  await expect(userPage.getByTestId('change-password-page')).toBeVisible();
  await expect(userPage.getByTestId('nav-projects')).toHaveCount(0);
});

test.describe('accessibility and phone layout', () => {
  test.describe.configure({ timeout: 90_000 });

  async function audit(page: Page) {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  }

  test('change-password page has no axe violations and fits a 390px screen', async () => {
    // userPage is on the forced change-password screen after the reset test.
    await expect(userPage.getByTestId('change-password-page')).toBeVisible();
    await audit(userPage);

    await userPage.setViewportSize({ width: 390, height: 844 });
    await expect(userPage.getByTestId('change-password-page')).toBeVisible();
    const { scrollWidth, clientWidth } = await userPage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  });

  test('add-user dialog has no axe violations', async () => {
    await adminPage.goto('/?admin=users');
    await adminPage.getByTestId('users-add').click();
    await expect(adminPage.getByTestId('add-user-dialog')).toBeVisible();
    await audit(adminPage);
  });
});
