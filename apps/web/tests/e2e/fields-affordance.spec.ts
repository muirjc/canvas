import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

const ERD_DSL = [
  'erDiagram',
  '  CUSTOMER {',
  '    string id PK',
  '    string name',
  '  }',
  '',
].join('\n');

const UML_DSL = [
  'classDiagram',
  '  class Animal {',
  '    +String name',
  '  }',
  '',
].join('\n');

const FLOWCHART_DSL = 'flowchart TD\n  one[One]\n';

async function openDiagram(page: Page, typeId: string, dsl: string) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId(`diagram-type-${typeId}`).check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill(dsl);
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]').first()).toBeVisible();
}

async function openErdDiagram(page: Page) {
  await openDiagram(page, 'erd', ERD_DSL);
}

async function openUmlDiagram(page: Page) {
  await openDiagram(page, 'uml', UML_DSL);
}

async function openFlowchartDiagram(page: Page) {
  await openDiagram(page, 'flowchart', FLOWCHART_DSL);
}

/**
 * canvas-vcv: a third affordance icon (alongside the pre-existing pencil/rename and
 * palette/fill-color affordances covered by label-affordance.spec.ts and style-affordance.spec.ts)
 * lets a user add/edit/remove ER attributes or UML class members directly on the canvas, instead
 * of only via the DSL panel or AI chat. Gated to `dslFamily === 'erd' | 'uml'` — every other family
 * (flowchart in particular, tested below) must never show it at all.
 */
test('the fields affordance is hidden by default and revealed on hover, on an ERD entity', async ({ page }) => {
  await openErdDiagram(page);

  const node = page.getByTestId('node-CUSTOMER');
  await expect(page.getByTestId('edit-fields-CUSTOMER')).toHaveCount(0);
  await node.hover();
  await expect(page.getByTestId('edit-fields-CUSTOMER')).toBeVisible();
});

test('the fields affordance reveals on selection too, so it is not hover-only', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.mouse.move(5, 5); // move the pointer well away, so only selection can be revealing it
  await expect(page.getByTestId('edit-fields-CUSTOMER')).toBeVisible();
});

test('the fields affordance does not appear at all on a flowchart node (family gating)', async ({ page }) => {
  await openFlowchartDiagram(page);

  const node = page.getByTestId('node-one');
  await node.hover();
  await node.click();
  await expect(page.getByTestId('edit-fields-one')).toHaveCount(0);
});

test('ERD: opening the popup and adding a new attribute updates the DSL', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('edit-fields-CUSTOMER').click();

  const addButton = page.getByTestId('attr-add-CUSTOMER');
  await expect(addButton).toBeDisabled();

  await page.getByTestId('attr-new-type-CUSTOMER').fill('string');
  await page.getByTestId('attr-new-name-CUSTOMER').fill('email');
  await expect(addButton).toBeEnabled();
  await addButton.click();

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('email');
  expect(dsl).toContain('string email');
});

test('ERD: editing an existing attribute updates the DSL', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('edit-fields-CUSTOMER').click();

  const nameInput = page.getByTestId('attr-name-CUSTOMER-0');
  await nameInput.fill('customerId');
  await nameInput.blur();

  const typeInput = page.getByTestId('attr-type-CUSTOMER-0');
  await typeInput.fill('int');
  await typeInput.blur();

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('customerId');
  expect(dsl).toContain('int customerId');
});

/**
 * canvas-hox follow-up: reported live that the add-row only offered type/name, with no way to
 * mark a new attribute as a key (PK/FK/UK) or attach a descriptive comment -- both real
 * EntityAttribute fields already supported by updateEntityAttributes/erd.ts, just not reachable
 * from this popup at all for a *new* attribute (an existing row already had a keys input).
 */
test('ERD: the add-row offers keys and comment, not just type/name', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('edit-fields-CUSTOMER').click();

  await page.getByTestId('attr-new-type-CUSTOMER').fill('string');
  await page.getByTestId('attr-new-name-CUSTOMER').fill('id');
  await page.getByTestId('attr-new-keys-CUSTOMER').fill('PK');
  await page.getByTestId('attr-new-comment-CUSTOMER').fill('the primary key');
  await page.getByTestId('attr-add-CUSTOMER').click();

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('string id PK "the primary key"');
});

test('ERD: an existing attribute\'s comment can be edited too, not just type/name/keys', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('edit-fields-CUSTOMER').click();

  const commentInput = page.getByTestId('attr-comment-CUSTOMER-0');
  await commentInput.fill('a note about id');
  await commentInput.blur();

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('"a note about id"');
});

test('ERD: removing an attribute removes it from the DSL', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('edit-fields-CUSTOMER').click();

  // Row 1 is "string name" — the second attribute in ERD_DSL.
  await page.getByTestId('attr-remove-CUSTOMER-1').click();

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).not.toContain('name');
  expect(dsl).toContain('string id PK');
});

test('UML: adding a new member as an attribute (default kind) updates the DSL', async ({ page }) => {
  await openUmlDiagram(page);

  await page.getByTestId('node-Animal').click();
  await page.getByTestId('edit-fields-Animal').click();

  const addButton = page.getByTestId('member-add-Animal');
  await expect(addButton).toBeDisabled();

  await page.getByTestId('member-new-name-Animal').fill('age');
  await page.getByTestId('member-new-type-Animal').fill('int');
  await expect(addButton).toBeEnabled();
  await addButton.click();

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('int age');
});

test('UML: switching the new-member kind to method swaps the visible fields, and adding produces correct DSL', async ({ page }) => {
  await openUmlDiagram(page);

  await page.getByTestId('node-Animal').click();
  await page.getByTestId('edit-fields-Animal').click();

  // Default kind is 'attribute': the type field is present, the method-only fields are not.
  await expect(page.getByTestId('member-new-type-Animal')).toBeVisible();
  await expect(page.getByTestId('member-new-params-Animal')).toHaveCount(0);
  await expect(page.getByTestId('member-new-return-Animal')).toHaveCount(0);

  await page.getByTestId('member-new-kind-Animal').selectOption('method');

  // Switched to method: the reverse — attribute-only type field is gone, method fields present.
  await expect(page.getByTestId('member-new-type-Animal')).toHaveCount(0);
  await expect(page.getByTestId('member-new-params-Animal')).toBeVisible();
  await expect(page.getByTestId('member-new-return-Animal')).toBeVisible();

  await page.getByTestId('member-new-name-Animal').fill('speak');
  await page.getByTestId('member-new-params-Animal').fill('volume: int');
  await page.getByTestId('member-new-return-Animal').fill('void');
  await page.getByTestId('member-add-Animal').click();

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('speak(volume: int) void');
});

test('clicking Done closes the fields popup without erroring', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('edit-fields-CUSTOMER').click();
  await expect(page.getByTestId('attr-new-name-CUSTOMER')).toBeVisible();

  await page.getByTestId('fields-done-CUSTOMER').click();
  await expect(page.getByTestId('attr-new-name-CUSTOMER')).toHaveCount(0);
});

test('pressing Escape while the fields popup is open closes it', async ({ page }) => {
  // Mirrors style-affordance.spec.ts's own Escape test: the popup's Escape handler is a plain
  // onKeyDown on its wrapping div, so it only fires if focus actually landed inside the popup in
  // the first place — FieldsPopup's add-row input carries autoFocus for exactly this reason.
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('edit-fields-CUSTOMER').click();
  await expect(page.getByTestId('attr-new-name-CUSTOMER')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('attr-new-name-CUSTOMER')).toHaveCount(0);
});

test('opening the fields popup closes the style popup, and vice versa', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();

  await page.getByTestId('edit-style-CUSTOMER').click();
  await expect(page.getByTestId('style-color-input-CUSTOMER')).toBeVisible();

  await page.getByTestId('edit-fields-CUSTOMER').click();
  await expect(page.getByTestId('style-color-input-CUSTOMER')).toHaveCount(0);
  await expect(page.getByTestId('attr-new-name-CUSTOMER')).toBeVisible();

  await page.getByTestId('edit-style-CUSTOMER').click();
  await expect(page.getByTestId('attr-new-name-CUSTOMER')).toHaveCount(0);
  await expect(page.getByTestId('style-color-input-CUSTOMER')).toBeVisible();
});

test('the fields affordance has an accessible name', async ({ page }) => {
  await openErdDiagram(page);

  await page.getByTestId('node-CUSTOMER').click();
  const affordance = page.getByTestId('edit-fields-CUSTOMER');
  const name = await affordance.getAttribute('aria-label');
  expect(name, 'fields affordance has no accessible name').toBeTruthy();
});
