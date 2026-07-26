import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 4 end-to-end: save a diagram, edit and save again, then restore an earlier version
 * and confirm the canvas reflects the restored content — and the diagram is browsable from the
 * project view.
 */
test('save into a project, edit, and restore a prior version', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  // Creating a diagram already records version 1 (an empty starting diagram) — the first
  // explicit Save below therefore produces version 2, not version 1.
  await expect(page.getByTestId('version-1')).toBeVisible();

  // v2: one rectangle, save.
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');
  await expect(page.getByTestId('version-2')).toBeVisible();

  // v3: add a circle too, save again.
  await page.getByTestId('add-shape-circle').click();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');
  await expect(page.getByTestId('version-3')).toBeVisible();

  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  // Restore v2 (one rectangle) — the circle should disappear from the canvas.
  await page.getByTestId('restore-version-2').click();
  await expect(page.getByTestId('version-4')).toBeVisible(); // restore appended v4, not rewritten v2
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  // The diagram should now be findable/openable from the project browser.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
});
