import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.4: (1) erSourceCardinality/erTargetCardinality could only ever be set at edge-
 * creation time via the connect-mode picker — no way to change an existing relationship's
 * cardinality short of deleting and redrawing it. (2) identifying (solid) vs. non-identifying
 * (dotted) had no toggle anywhere, not even at connect time.
 */

const ERD_DSL = ['erDiagram', '  CUSTOMER ||--o{ ORDER : places', ''].join('\n');

async function login(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importDsl(page: Page, name: string, dsl: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(dsl);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

test('the connect-mode ER picker now offers a Non-identifying checkbox', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ER Connect Non-identifying Checkbox', ERD_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await expect(page.getByTestId('connect-er-non-identifying')).toBeVisible();
});

test('drawing a connection with Non-identifying checked produces a dotted relationship line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ER Draw Non-identifying', 'erDiagram\n  CUSTOMER\n  ORDER\n');

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-er-non-identifying').check();
  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('node-ORDER').click();

  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  const source = await dsl(page);
  expect(source).toContain('CUSTOMER ||..o{ ORDER');
});

test('drawing a connection with the checkbox left unchecked stays a solid (identifying) line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ER Draw Identifying Default', 'erDiagram\n  CUSTOMER\n  ORDER\n');

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('node-ORDER').click();

  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  const source = await dsl(page);
  expect(source).toContain('CUSTOMER ||--o{ ORDER');
});

test('an existing relationship\'s cardinality can be changed post-hoc via the edge affordance', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ER Post-hoc Cardinality', ERD_DSL);

  const edge = page.locator('[data-testid^="edge-"]').first();
  const edgeId = (await edge.getAttribute('data-testid'))!.replace('edge-', '');
  await edge.hover();
  await page.getByTestId(`edit-kind-${edgeId}`).click();
  await page.getByTestId(`er-source-cardinality-select-${edgeId}`).selectOption('|o');
  await page.getByTestId(`er-target-cardinality-select-${edgeId}`).selectOption('|{');
  await page.getByTestId(`er-cardinality-done-${edgeId}`).click();

  const source = await dsl(page);
  expect(source).toContain('CUSTOMER |o--|{ ORDER');
});

test('an existing relationship can be toggled to non-identifying post-hoc', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ER Post-hoc Non-identifying', ERD_DSL);

  const edge = page.locator('[data-testid^="edge-"]').first();
  const edgeId = (await edge.getAttribute('data-testid'))!.replace('edge-', '');
  await edge.hover();
  await page.getByTestId(`edit-kind-${edgeId}`).click();
  await page.getByTestId(`er-non-identifying-${edgeId}`).check();
  await page.getByTestId(`er-cardinality-done-${edgeId}`).click();

  const source = await dsl(page);
  expect(source).toContain('CUSTOMER ||..o{ ORDER');
});

test('toggling non-identifying back off restores a solid line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ER Post-hoc Back To Identifying', 'erDiagram\n  CUSTOMER ||..o{ ORDER : places\n');

  const edge = page.locator('[data-testid^="edge-"]').first();
  const edgeId = (await edge.getAttribute('data-testid'))!.replace('edge-', '');
  await edge.hover();
  await page.getByTestId(`edit-kind-${edgeId}`).click();
  await expect(page.getByTestId(`er-non-identifying-${edgeId}`)).toBeChecked();
  await page.getByTestId(`er-non-identifying-${edgeId}`).uncheck();
  await page.getByTestId(`er-cardinality-done-${edgeId}`).click();

  const source = await dsl(page);
  expect(source).toContain('CUSTOMER ||--o{ ORDER');
});

test('the cardinality edge affordance is absent for non-ERD/UML families', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Flowchart No Cardinality Affordance', 'flowchart TD\n  A[Start] --> B[End]\n');

  const edge = page.locator('[data-testid^="edge-"]').first();
  const edgeId = (await edge.getAttribute('data-testid'))!.replace('edge-', '');
  await edge.hover();
  await expect(page.getByTestId(`edit-kind-${edgeId}`)).toHaveCount(0);
});
