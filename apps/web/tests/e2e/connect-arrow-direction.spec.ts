import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function newDiagramWithTwoShapes(page: import('@playwright/test').Page) {
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
}

/**
 * canvas-7rr: connect mode always drew a plain forward arrow, with no affordance to reverse
 * direction or make a connector bidirectional/arrowless — the only workaround was drawing two
 * separate edges (A->B and B->A) to fake a two-way relationship. A "Direction" picker now appears
 * in the toolbar only while connect mode is active, applied to the connection about to be drawn.
 */
test('draws a bidirectional connector when Bidirectional is chosen', async ({ page }) => {
  await newDiagramWithTwoShapes(page);

  await page.getByTestId('connect-mode-toggle').click();
  await expect(page.getByTestId('connect-arrow-style')).toBeVisible();
  await page.getByTestId('connect-arrow-style').selectOption('both');

  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click();

  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  await expect(page.getByTestId('dsl-panel')).toContainText('<-->');
});

test('draws a connector with no arrowhead when No arrowhead is chosen', async ({ page }) => {
  await newDiagramWithTwoShapes(page);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-arrow-style').selectOption('none');

  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click();

  const dsl = await page.getByTestId('dsl-panel').inputValue();
  // Plain no-arrowhead connector syntax, not the default `-->` or the bidirectional `<-->`.
  expect(dsl).toMatch(/---/);
  expect(dsl).not.toContain('-->');
});

test('reverses source/target when Reversed is chosen — no separate second edge needed', async ({ page }) => {
  await newDiagramWithTwoShapes(page);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-arrow-style').selectOption('reversed');

  const nodes = page.locator('[data-testid^="node-"]');
  const firstId = await nodes.nth(0).getAttribute('data-testid');
  const secondId = await nodes.nth(1).getAttribute('data-testid');
  await nodes.nth(0).click();
  await nodes.nth(1).click();

  // Exactly one edge exists — a "reversed" connection is the swapped endpoint, not a second edge
  // stacked on top of a forward one.
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  const firstNodeId = firstId!.replace('node-', '');
  const secondNodeId = secondId!.replace('node-', '');
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  // The second-clicked shape is the arrow's source, the first-clicked is its target.
  const reversedLine = new RegExp(`${secondNodeId}\\s*-->\\s*${firstNodeId}`);
  expect(dsl).toMatch(reversedLine);
});

test('defaults to a plain forward arrow when no direction is chosen', async ({ page }) => {
  await newDiagramWithTwoShapes(page);

  await page.getByTestId('connect-mode-toggle').click();
  const nodes = page.locator('[data-testid^="node-"]');
  await nodes.nth(0).click();
  await nodes.nth(1).click();

  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('-->');
  expect(dsl).not.toContain('<-->');
});
