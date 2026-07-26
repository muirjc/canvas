import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signInAndCreateDiagram(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/**
 * User Story 2 (feature 002) end-to-end: shape deletion (with confirmation), cascading
 * connector removal, multi-select, and auto-removal of an emptied group.
 */
test('deletes an unconnected shape after confirming', async ({ page }) => {
  await signInAndCreateDiagram(page);
  await page.getByTestId('add-shape-rectangle').click();
  await page.locator('[data-testid^="node-"]').first().click();
  await page.getByTestId('delete-selected').click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(0);
  await expect(page.getByTestId('dsl-panel')).not.toContainText('New Node');
});

test('cancelling the confirmation leaves the shape untouched', async ({ page }) => {
  await signInAndCreateDiagram(page);
  await page.getByTestId('add-shape-rectangle').click();
  await page.locator('[data-testid^="node-"]').first().click();
  await page.getByTestId('delete-selected').click();
  await page.getByTestId('confirm-dialog-cancel').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
});

test('deleting a connected shape also removes its connector (no dangling reference)', async ({ page }) => {
  await signInAndCreateDiagram(page);
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('add-shape-circle').click();
  await page.getByTestId('connect-mode-toggle').click();
  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  await nodes.nth(0).click();
  await page.getByTestId('delete-selected').click();
  await page.getByTestId('confirm-dialog-confirm').click();

  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(0);
  await expect(page.getByTestId('dsl-panel')).not.toContainText('-->');
});

test('multi-select deletes several shapes in one confirmation', async ({ page }) => {
  await signInAndCreateDiagram(page);
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('add-shape-circle').click();
  await page.getByTestId('add-shape-diamond').click();

  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ['Shift'] });
  await page.getByTestId('delete-selected').click();
  await page.getByTestId('confirm-dialog-confirm').click();

  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
});

test("deleting a group's last member shape auto-removes the now-empty group", async ({ page }) => {
  await signInAndCreateDiagram(page);
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('add-shape-circle').click();

  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click({ modifiers: ['Shift'] });
  await page.getByTestId('group-selected').click();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(1);

  // Delete both members of the group, one at a time.
  await nodes.nth(0).click();
  await page.getByTestId('delete-selected').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(1); // one member remains

  await page.locator('[data-testid^="node-"]').first().click();
  await page.getByTestId('delete-selected').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(0); // group auto-removed
});

test('the Delete key also triggers the confirmation for a selected shape', async ({ page }) => {
  await signInAndCreateDiagram(page);
  await page.getByTestId('add-shape-rectangle').click();
  await page.locator('[data-testid^="node-"]').first().click();
  await page.getByTestId('canvas-root').focus();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(0);
});
