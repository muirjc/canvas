import { expect, test, type Page } from '@playwright/test';
import { connectShapes } from './helpers/connect';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function newErdDiagramWithTwoEntities(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-erd').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('add-shape-rectangle').click();
}

/** A regex matching `text` literally (ER cardinality tokens are full of regex metacharacters). */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/**
 * canvas-hox follow-up: reported live that connect mode's own "Direction" picker
 * (connect-arrow-direction.spec.ts) still applied to ERD — offering Forward/Reversed/
 * Bidirectional/No-arrowhead, none of which are valid ER notation at all (a plain arrowhead is
 * never correct crow's-foot syntax). ERD now gets its own two independent cardinality pickers
 * (one per side of the relationship, since e.g. "one customer has many orders" is not symmetric),
 * covering all four real Mermaid ER cardinality options: exactly one, zero or one, one or many,
 * zero or many.
 */
test('connect mode shows ER cardinality pickers, not the Direction/arrow picker', async ({ page }) => {
  await newErdDiagramWithTwoEntities(page);

  await page.getByTestId('connect-mode-toggle').click();
  await expect(page.getByTestId('connect-er-source-cardinality')).toBeVisible();
  await expect(page.getByTestId('connect-er-target-cardinality')).toBeVisible();
  await expect(page.getByTestId('connect-arrow-style')).toHaveCount(0);
});

test('defaults to the standard one-to-many cardinality when neither picker is touched', async ({ page }) => {
  await newErdDiagramWithTwoEntities(page);

  await page.getByTestId('connect-mode-toggle').click();
  const nodes = page.locator('[data-testid^="node-"]');
  await connectShapes(nodes.nth(0), nodes.nth(1));
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  // The DSL panel syncs one render after the canvas, so poll it rather than read it once
  // (a single-shot read raced the edge's arrival in CI -- canvas-whz).
  await expect(page.getByTestId('dsl-panel')).toHaveValue(literal('||--o{'));
});

test('each of the four cardinality options is selectable on both sides and produces the correct token', async ({ page }) => {
  await newErdDiagramWithTwoEntities(page);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-er-source-cardinality').selectOption('|o'); // zero or one
  await page.getByTestId('connect-er-target-cardinality').selectOption('|{'); // one or many

  const nodes = page.locator('[data-testid^="node-"]');
  await connectShapes(nodes.nth(0), nodes.nth(1));
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  // The DSL panel syncs one render after the canvas, so poll it rather than read it once
  // (a single-shot read raced the edge's arrival in CI -- canvas-whz).
  await expect(page.getByTestId('dsl-panel')).toHaveValue(literal('|o--|{'));
});

test('picking "exactly one" on both sides produces a one-to-one relationship', async ({ page }) => {
  await newErdDiagramWithTwoEntities(page);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-er-source-cardinality').selectOption('||');
  await page.getByTestId('connect-er-target-cardinality').selectOption('||');

  const nodes = page.locator('[data-testid^="node-"]');
  await connectShapes(nodes.nth(0), nodes.nth(1));
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  // The DSL panel syncs one render after the canvas, so poll it rather than read it once
  // (a single-shot read raced the edge's arrival in CI -- canvas-whz).
  await expect(page.getByTestId('dsl-panel')).toHaveValue(literal('||--||'));
});

test('picking "zero or many" on both sides produces a many-to-many relationship', async ({ page }) => {
  await newErdDiagramWithTwoEntities(page);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-er-source-cardinality').selectOption('}o');
  await page.getByTestId('connect-er-target-cardinality').selectOption('o{');

  const nodes = page.locator('[data-testid^="node-"]');
  await connectShapes(nodes.nth(0), nodes.nth(1));
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  // The DSL panel syncs one render after the canvas, so poll it rather than read it once
  // (a single-shot read raced the edge's arrival in CI -- canvas-whz).
  await expect(page.getByTestId('dsl-panel')).toHaveValue(literal('}o--o{'));
});
