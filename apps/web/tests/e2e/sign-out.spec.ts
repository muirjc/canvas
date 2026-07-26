import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: import('@playwright/test').Page) {
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

/**
 * User Story 3 (feature 002) end-to-end: a visible, always-reachable sign-out control that
 * actually ends the session — not just at the API level (which already existed) but reachable
 * from the UI, from every screen.
 */
test('signs out from the main screen and requires re-authentication afterward', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await signIn(page);

  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('login-submit')).toBeVisible();

  // Reloading the same URL requires signing in again — no stale session/content is shown.
  await page.reload();
  await expect(page.getByTestId('login-submit')).toBeVisible();
});

test('sign-out is reachable from the diagram editor', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await signIn(page);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('login-submit')).toBeVisible();
});

test('sign-out is reachable from an admin screen', async ({ page }) => {
  await page.goto('/?admin=true');
  await signIn(page);
  await expect(page.getByTestId('sign-out')).toBeVisible();
});
