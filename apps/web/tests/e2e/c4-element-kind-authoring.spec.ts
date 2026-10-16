import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.5: (1) updateNodeRole existed in diagram-ops.ts but Canvas.tsx never called it — a
 * C4 element's kind (person/system/container/component) could not be set or changed visually at
 * all. (2) the toolbar's C4 shape set was missing person/cylinder/stadium entirely, so a Db/Queue/
 * Person element could only ever come from DSL/import, never toolbar creation.
 */

// canvas-cc3: an import now lands on the type its header names. These specs use a C4Container
// diagram: its starter standard (canvas-chq) is non-strict, so the free shape toolbar stays, and its
// popup offers the standard's element KINDS (person, software_system, container, ... and external
// variants) rather than raw roles -- so the popup specs pick kinds by id. (C4 Context's strict
// reference standard would hide the shape toolbar these specs exercise.)
const C4_DSL = ['C4Container', '  Person(user, "User")', '  System(sys, "System")', ''].join('\n');

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

test('the C4 toolbar offers person, database (cylinder), and queue (stadium), alongside the 4 universal shapes', async ({ page }) => {
  await login(page);
  await importDsl(page, 'C4 Toolbar Shapes', C4_DSL);

  for (const testId of ['add-shape-rectangle', 'add-shape-rounded-rectangle', 'add-shape-circle', 'add-shape-diamond', 'add-shape-person', 'add-shape-cylinder', 'add-shape-stadium']) {
    await expect(page.getByTestId(testId)).toBeVisible();
  }
});

test('the C4 toolbar is absent for a flowchart diagram (family gating, unchanged)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Flowchart Not C4 Shapes', 'flowchart TD\n  A[Start]\n');
  await expect(page.getByTestId('add-shape-person')).toHaveCount(0);
  await expect(page.getByTestId('add-shape-cylinder')).toHaveCount(0);
});

test('clicking "Database" creates a real cylinder-shaped node on the canvas', async ({ page }) => {
  await login(page);
  await importDsl(page, 'C4 Add Cylinder', C4_DSL);

  const before = page.locator('[data-testid^="node-"]');
  const countBefore = await before.count();
  await page.getByTestId('add-shape-cylinder').click();
  await expect(before).toHaveCount(countBefore + 1);
});

test('the element-kind affordance and popup are absent for non-C4 families', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML No Kind Affordance', 'classDiagram\n  class Animal\n');
  await page.getByTestId('node-Animal').hover();
  await expect(page.getByTestId('edit-kind-Animal')).toHaveCount(0);
});

test('setting an existing element\'s kind to Container via the popup produces a real "Container(" line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'C4 Set Kind Container', C4_DSL);

  await page.getByTestId('node-sys').hover();
  await page.getByTestId('edit-kind-sys').click();
  await page.getByTestId('kind-role-select-sys').selectOption('container');
  await page.getByTestId('kind-done-sys').click();

  const source = await dsl(page);
  expect(source).toMatch(/Container\(sys,/);
});

test('a toolbar-added cylinder node, given kind=System via the popup, serializes as "SystemDb("', async ({ page }) => {
  await login(page);
  await importDsl(page, 'C4 Cylinder Plus System Kind', C4_DSL);

  await page.getByTestId('add-shape-cylinder').click();
  const newNode = page.locator('[data-testid^="node-"]').last();
  const newNodeId = (await newNode.getAttribute('data-testid'))!.replace('node-', '');

  await newNode.hover();
  await page.getByTestId(`edit-kind-${newNodeId}`).click();
  await page.getByTestId(`kind-role-select-${newNodeId}`).selectOption('software_system');
  await page.getByTestId(`kind-done-${newNodeId}`).click();

  const source = await dsl(page);
  expect(source).toContain(`SystemDb(${newNodeId},`);
});

test('the kind popup reflects the element\'s current role when reopened', async ({ page }) => {
  await login(page);
  await importDsl(page, 'C4 Kind Popup Reflects Role', C4_DSL);

  await page.getByTestId('node-sys').hover();
  await page.getByTestId('edit-kind-sys').click();
  await expect(page.getByTestId('kind-role-select-sys')).toHaveValue('software_system');
});
