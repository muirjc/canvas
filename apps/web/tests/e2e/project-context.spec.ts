import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/**
 * Regression: the three project-scoped actions on the home screen are reachable only when the
 * URL already carries `?projectId=`, and nothing in the UI ever puts it there. Every other spec
 * in this directory navigates to `/?projectId=${PROJECT_ID}` explicitly, which masks the defect
 * completely — so these tests deliberately enter the app the way a real user does.
 */

test('a user landing on the app root can create a diagram', async ({ page }) => {
  // The real entry point: no query string at all.
  await signIn(page, '/');

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();

  // The user picked a type and confirmed; they must end up in the editor, not staring at an
  // instruction to hand-edit the address bar.
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
});

test('the other two home actions work for a user landing on the app root', async ({ page }) => {
  await signIn(page, '/');

  await page.getByTestId('import-diagram-button').click();
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  await expect(page.getByTestId('import-textarea')).toBeVisible();
  await page.getByTestId('cancel-import').click();

  await page.getByTestId('create-via-ai-chat').click();
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  await expect(page.getByTestId('ai-create-description')).toBeVisible();
});

test('the project context survives a round trip through the admin console', async ({ page }) => {
  // Enter the way the rest of the suite does — with a project — then navigate only by clicking.
  await signIn(page, `/?projectId=${PROJECT_ID}`);

  await page.getByTestId('admin-users-link').click();
  await expect(page.getByTestId('admin-shell')).toBeVisible();

  await page.getByTestId('admin-back-to-diagrams').click();
  await expect(page.getByTestId('new-diagram')).toBeVisible();

  // The admin nav links carry no projectId, so the back link has none left to restore.
  expect(new URL(page.url()).searchParams.get('projectId')).toBe(PROJECT_ID);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
});
