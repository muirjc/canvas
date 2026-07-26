import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 4 (feature 002) end-to-end: an owner deletes a diagram (with confirmation); it
 * disappears from the project browser; an admin sees only its metadata in the deleted-diagrams
 * list and restores it, making it fully accessible again.
 */
test('deletes a diagram, sees it only as metadata, and restores it', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(OWNER_EMAIL);
  await page.getByTestId('login-password').fill(OWNER_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // Go back to the main screen to see it listed in the project browser.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const deleteButtons = page.locator('[data-testid^="delete-diagram-"]');
  const countBefore = await deleteButtons.count();
  expect(countBefore).toBeGreaterThan(0);

  await deleteButtons.first().click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-confirm').click();

  // Gone from the project browser immediately.
  await expect(page.locator('[data-testid^="delete-diagram-"]')).toHaveCount(countBefore - 1);

  // Admin sees it in the deleted-diagrams list — metadata only, no way to view its content.
  await page.goto('/?admin=deleted');
  const restoreButtons = page.locator('[data-testid^="restore-diagram-"]');
  await expect(restoreButtons.first()).toBeVisible();

  await restoreButtons.first().click();
  await expect(page.getByTestId('deleted-diagrams-message')).toContainText('restored');

  // Back in the project browser for the owner.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.locator('[data-testid^="delete-diagram-"]')).toHaveCount(countBefore);
});

test('cancelling the delete confirmation leaves the diagram in place', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(OWNER_EMAIL);
  await page.getByTestId('login-password').fill(OWNER_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await expect(page.getByTestId('project-browser')).toBeVisible();
  const deleteButtons = page.locator('[data-testid^="delete-diagram-"]');
  const countBefore = await deleteButtons.count();
  expect(countBefore).toBeGreaterThan(0);

  await deleteButtons.first().click();
  await page.getByTestId('confirm-dialog-cancel').click();
  await expect(page.locator('[data-testid^="delete-diagram-"]')).toHaveCount(countBefore);
});
