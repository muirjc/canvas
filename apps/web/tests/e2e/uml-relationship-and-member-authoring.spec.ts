import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.3: (1) umlRelationKind + cardinality had no UI at connect-mode or post-hoc — a UML
 * relationship's kind (inheritance/composition/...) could only ever come from DSL/import.
 * (2) ClassMember.isStatic/isAbstract had no checkbox anywhere. (3) DiagramNode.umlStereotype had
 * no UI or AI tool at all.
 */

const UML_DSL = ['classDiagram', '  class Animal', '  class Dog', ''].join('\n');

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

test('UML connect-mode shows the relationship-kind + cardinality picker, not the generic Direction picker', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Connect Picker', UML_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await expect(page.getByTestId('connect-uml-relation-kind')).toBeVisible();
  await expect(page.getByTestId('connect-uml-source-cardinality')).toBeVisible();
  await expect(page.getByTestId('connect-uml-target-cardinality')).toBeVisible();
  await expect(page.getByTestId('connect-arrow-style')).toHaveCount(0);
});

test('drawing a connection with kind=inheritance and cardinalities produces a real "<|--" line with quoted cardinality', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Draw Inheritance', UML_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('connect-uml-relation-kind').selectOption('inheritance');
  await page.getByTestId('connect-uml-source-cardinality').fill('1');
  await page.getByTestId('connect-uml-target-cardinality').fill('*');
  await page.getByTestId('node-Dog').click();
  await page.getByTestId('node-Animal').click();

  // canvas-i2q precedent (connect-arrow-direction.spec.ts): without this wait, reading the DSL
  // panel below can race the second click's React state update.
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  const source = await dsl(page);
  expect(source).toContain('Dog "1" <|-- "*" Animal');
});

test('drawing a connection with no picker changes defaults to a plain association, no cardinality', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Draw Default', UML_DSL);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('node-Dog').click();
  await page.getByTestId('node-Animal').click();

  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  const source = await dsl(page);
  expect(source).toContain('Dog --> Animal');
});

test('an existing relationship\'s kind can be changed post-hoc via the edge affordance', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Post-hoc Kind', 'classDiagram\n  class Animal\n  class Dog\n  Dog --> Animal\n');

  const edge = page.locator('[data-testid^="edge-"]').first();
  const edgeId = (await edge.getAttribute('data-testid'))!.replace('edge-', '');
  await edge.hover();
  await page.getByTestId(`edit-kind-${edgeId}`).click();
  await page.getByTestId(`relation-kind-select-${edgeId}`).selectOption('composition');
  await page.getByTestId(`relation-source-cardinality-${edgeId}`).fill('1');
  await page.getByTestId(`relation-kind-done-${edgeId}`).click();

  const source = await dsl(page);
  expect(source).toContain('Dog "1" *-- Animal');
});

test('the relationship-kind edge affordance is absent for non-UML families', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Flowchart No Relation Kind', 'flowchart TD\n  A[Start] --> B[End]\n');

  const edge = page.locator('[data-testid^="edge-"]').first();
  const edgeId = (await edge.getAttribute('data-testid'))!.replace('edge-', '');
  await edge.hover();
  await expect(page.getByTestId(`edit-kind-${edgeId}`)).toHaveCount(0);
});

test('a new member added with the static checkbox checked serializes with a "$" suffix', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Static Member', UML_DSL);

  await page.getByTestId('node-Animal').hover();
  await page.getByTestId('edit-fields-Animal').click();
  await page.getByTestId('member-new-name-Animal').fill('score');
  await page.getByTestId('member-new-static-Animal').check();
  await page.getByTestId('member-add-Animal').click();

  const source = await dsl(page);
  expect(source).toContain('score$');
});

test('toggling an existing member\'s abstract checkbox serializes with a "*" suffix', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Abstract Member', 'classDiagram\n  class Animal {\n    +makeSound()\n  }\n');

  await page.getByTestId('node-Animal').hover();
  await page.getByTestId('edit-fields-Animal').click();
  await page.getByTestId('member-abstract-Animal-0').check();

  const source = await dsl(page);
  expect(source).toContain('makeSound()*');
});

test('setting a class\'s stereotype via the fields popup header produces a real "<<...>>" annotation', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Stereotype', UML_DSL);

  await page.getByTestId('node-Animal').hover();
  await page.getByTestId('edit-fields-Animal').click();
  await page.getByTestId('stereotype-Animal').fill('interface');
  await page.getByTestId('stereotype-Animal').blur();

  const source = await dsl(page);
  expect(source).toContain('class Animal <<interface>>');
});

test('the stereotype field is absent from the ERD fields popup (UML-only)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'ERD No Stereotype', 'erDiagram\n  CUSTOMER {\n    string id PK\n  }\n');

  await page.getByTestId('node-CUSTOMER').hover();
  await page.getByTestId('edit-fields-CUSTOMER').click();
  await expect(page.getByTestId('stereotype-CUSTOMER')).toHaveCount(0);
});
