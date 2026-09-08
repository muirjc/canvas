import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.6: (1) junction node creation (role: 'junction', shape: 'circle',
 * dsl/architecture.ts:123-137) had no toolbar/AI-tool entry at all — add one. (2) the {group} edge
 * modifier (sourceIsGroup/targetIsGroup) and :T/B/L/R anchor hints (sourceAnchor/targetAnchor)
 * already rendered but were never settable — add an architecture-specific connect-mode picker,
 * mirroring the ERD/UML ones. (3) the toolbar's dead "Add Shape" grid (serializeArchitecture
 * ignores shape for every non-junction node) is now hidden for architecture — covered here too,
 * alongside the two functional gaps.
 */

const ARCHITECTURE_DSL = [
  'architecture-beta',
  '  service left(cloud)[Left]',
  '  service right(cloud)[Right]',
  '',
].join('\n');

async function login(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importDsl(page: Page, name: string, source: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(source);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

test('the shape toolbar is absent for architecture (getAddableShapes returns [])', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture No Shape Toolbar', ARCHITECTURE_DSL);
  await expect(page.getByTestId('add-shape-rectangle')).toHaveCount(0);
  await expect(page.getByTestId('add-shape-circle')).toHaveCount(0);
});

test('Add Junction is offered for architecture', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture Add Junction Visible', ARCHITECTURE_DSL);
  await expect(page.getByTestId('add-junction')).toBeVisible();
});

test('Add Junction is absent for other families', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Flowchart No Add Junction', 'flowchart TD\n  A[Start]\n');
  await expect(page.getByTestId('add-junction')).toHaveCount(0);
});

test('clicking Add Junction creates a real "junction <id>" line, not a service', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture Junction DSL', ARCHITECTURE_DSL);

  const before = page.locator('[data-testid^="node-"]');
  const countBefore = await before.count();
  await page.getByTestId('add-junction').click();
  await expect(before).toHaveCount(countBefore + 1);

  const source = await dsl(page);
  expect(source).toMatch(/^junction n\w+$/m);
});

test('connect mode shows the architecture picker, not the generic Direction picker', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture Connect Picker', ARCHITECTURE_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await expect(page.getByTestId('connect-arch-direction')).toBeVisible();
  await expect(page.getByTestId('connect-arrow-style')).toHaveCount(0);
});

test('"Forward" direction produces "-->", the default before this bead had no effect', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture Forward Arrow', ARCHITECTURE_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('node-left').click();
  await page.getByTestId('node-right').click();

  const source = await dsl(page);
  expect(source).toMatch(/left\S* --> \S*right/);
});

test('"Reversed" direction produces "<--"', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture Reversed Arrow', ARCHITECTURE_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-arch-direction').selectOption('reversed');
  await page.getByTestId('node-left').click();
  await page.getByTestId('node-right').click();

  const source = await dsl(page);
  expect(source).toMatch(/left\S* <-- \S*right/);
});

test('"No arrowhead" produces a plain "--" connector', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture No Arrowhead', ARCHITECTURE_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-arch-direction').selectOption('none');
  await page.getByTestId('node-left').click();
  await page.getByTestId('node-right').click();

  const source = await dsl(page);
  expect(source).toMatch(/left\S* -- \S*right/);
});

test('checking "First entity\'s group" produces a {group} suffix on the source side', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture Source Group', ARCHITECTURE_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-arch-source-is-group').check();
  await page.getByTestId('node-left').click();
  await page.getByTestId('node-right').click();

  const source = await dsl(page);
  expect(source).toContain('left{group} --> right');
});

test('picking an anchor on each side produces real :T/:B tokens', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Architecture Anchors', ARCHITECTURE_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-arch-source-anchor').selectOption('B');
  await page.getByTestId('connect-arch-target-anchor').selectOption('T');
  await page.getByTestId('node-left').click();
  await page.getByTestId('node-right').click();

  const source = await dsl(page);
  expect(source).toContain('left:B --> T:right');
});
