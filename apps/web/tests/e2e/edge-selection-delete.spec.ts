import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const SELECTION_STROKE = '#2563eb';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function openDiagramWithTwoConnectedShapes(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('flowchart TD\n  one[One]\n  two[Two]\n  one --> two\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
}

function edgeLine(page: Page) {
  return page.locator('[data-testid^="edge-"]').first().locator('line');
}

/**
 * canvas-u7e: edges had no selection state at all — the only ways to remove a connector were
 * deleting one of its endpoint nodes (which cascades but also destroys the node) or hand-editing
 * the DSL panel. This covers direct selection and deletion of a connector on the canvas.
 */
test('clicking a connector selects it, coloring its line the selection blue', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await expect(edgeLine(page)).not.toHaveAttribute('stroke', SELECTION_STROKE);
  await page.locator('[data-testid^="edge-"]').first().click();
  await expect(edgeLine(page)).toHaveAttribute('stroke', SELECTION_STROKE);
});

test('Delete Selected is disabled with nothing selected, enabled once an edge is selected', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await expect(page.getByTestId('delete-selected')).toBeDisabled();
  await page.locator('[data-testid^="edge-"]').first().click();
  await expect(page.getByTestId('delete-selected')).toBeEnabled();
});

test('deleting a selected connector via the button removes it but leaves both endpoint nodes intact', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.locator('[data-testid^="edge-"]').first().click();
  await page.getByTestId('delete-selected').click();

  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(/connector/i);
  await page.getByTestId('confirm-dialog-confirm').click();

  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
  await expect(page.getByTestId('dsl-panel')).not.toContainText('-->');
});

test('the Delete/Backspace shortcut also removes a selected connector, leaving nodes untouched', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.locator('[data-testid^="edge-"]').first().click();
  await page.getByTestId('canvas-root').focus();
  await page.keyboard.press('Delete');

  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(/connector/i);
  await page.getByTestId('confirm-dialog-confirm').click();

  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
});

test('selecting a node clears a prior edge selection, and selecting an edge clears a prior node selection', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);
  const nodeOneRect = page.getByTestId('node-one').locator('rect').first();

  // Select the edge first.
  await page.locator('[data-testid^="edge-"]').first().click();
  await expect(edgeLine(page)).toHaveAttribute('stroke', SELECTION_STROKE);

  // Selecting a node clears the edge selection.
  await page.getByTestId('node-one').click();
  await expect(edgeLine(page)).not.toHaveAttribute('stroke', SELECTION_STROKE);
  await expect(nodeOneRect).toHaveAttribute('stroke', SELECTION_STROKE);

  // Selecting the edge again clears the node selection.
  await page.locator('[data-testid^="edge-"]').first().click();
  await expect(edgeLine(page)).toHaveAttribute('stroke', SELECTION_STROKE);
  await expect(nodeOneRect).not.toHaveAttribute('stroke', SELECTION_STROKE);
});

test('clicking empty canvas background deselects a previously-selected connector', async ({ page }) => {
  await openDiagramWithTwoConnectedShapes(page);

  await page.locator('[data-testid^="edge-"]').first().click();
  await expect(edgeLine(page)).toHaveAttribute('stroke', SELECTION_STROKE);
  await expect(page.getByTestId('delete-selected')).toBeEnabled();

  // Both auto-laid-out nodes sit near the top-left of the canvas (nextAutoPosition), so a click
  // well into the bottom-right corner (computed from the actual rendered size, which can be
  // smaller than a hardcoded guess) is guaranteed to land on empty SVG background, not on either
  // shape or the edge's own padded hit-target rect.
  const canvas = page.getByTestId('diagram-canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width - 20, y: box.height - 20 } });

  await expect(edgeLine(page)).not.toHaveAttribute('stroke', SELECTION_STROKE);
  await expect(page.getByTestId('delete-selected')).toBeDisabled();
});
