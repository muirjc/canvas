import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 1 (feature 002) end-to-end: rename a shape, and add/edit/clear a connector label —
 * connector labeling has no supported path before this feature.
 */
test('edits shape and connector labels', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('add-shape-circle').click();

  // Rename a shape (already-existing behavior, still exercised here as part of this story).
  const firstNode = page.locator('[data-testid^="node-"]').first();
  await firstNode.dblclick();
  const nodeInput = page.locator('[data-testid^="node-label-input-"]').first();
  await nodeInput.fill('Renamed Shape');
  await nodeInput.press('Enter');
  await expect(page.getByTestId('dsl-panel')).toContainText('Renamed Shape');

  // Connect the two shapes, then add a connector label — previously unsupported entirely.
  await page.getByTestId('connect-mode-toggle').click();
  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click();

  const edge = page.locator('[data-testid^="edge-"]').first();
  await edge.dblclick();
  const edgeInput = page.locator('[data-testid^="edge-label-input-"]').first();
  await edgeInput.fill('flows to');
  await edgeInput.press('Enter');
  await expect(page.getByTestId('dsl-panel')).toContainText('flows to');

  // Edit the connector label to a new value.
  await edge.dblclick();
  const edgeInputAgain = page.locator('[data-testid^="edge-label-input-"]').first();
  await edgeInputAgain.fill('updated label');
  await edgeInputAgain.press('Enter');
  await expect(page.getByTestId('dsl-panel')).toContainText('updated label');
  await expect(page.getByTestId('dsl-panel')).not.toContainText('flows to');

  // Clear the connector label entirely.
  await edge.dblclick();
  const edgeInputClear = page.locator('[data-testid^="edge-label-input-"]').first();
  await edgeInputClear.fill('');
  await edgeInputClear.press('Enter');
  await expect(page.getByTestId('dsl-panel')).not.toContainText('updated label');

  // Cancel an in-progress edit — original label untouched.
  await firstNode.dblclick();
  const cancelInput = page.locator('[data-testid^="node-label-input-"]').first();
  await cancelInput.fill('Should Not Save');
  await cancelInput.press('Escape');
  await expect(page.getByTestId('dsl-panel')).toContainText('Renamed Shape');
  await expect(page.getByTestId('dsl-panel')).not.toContainText('Should Not Save');
});
