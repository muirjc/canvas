import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.1: DiagramContainer.role/parentContainerId could not be set by any canvas UI (or AI
 * tool) at all — Add Container/Group into Container always produced a plain, role-less container,
 * regardless of diagram family. Confirms the new "Container Kind" picker actually reaches the
 * model/DSL for the three node-based container roles this bead scopes in: UML namespace/note, C4
 * boundary kinds, and sequence's box (participant grouping). Ranged sequence blocks (loop/alt/...)
 * are deliberately out of scope here — filed as canvas-2s6.2 (they enclose messages, not nodes).
 */

const UML_DSL = ['classDiagram', '  class Animal', '  class Dog', ''].join('\n');
const C4_DSL = ['C4Context', '  Person(user, "User")', '  System(sys, "System")', ''].join('\n');
const SEQUENCE_DSL = ['sequenceDiagram', '  participant A', '  participant B', ''].join('\n');

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

async function selectBoth(page: Page, firstId: string, secondId: string) {
  await page.getByTestId(`node-${firstId}`).click();
  await page.getByTestId(`node-${secondId}`).click({ modifiers: ['Shift'] });
}

test('UML: grouping two classes with Kind=Namespace produces a real "namespace ... {" block', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Namespace Authoring', UML_DSL);

  // Namespace is the default first option — no need to change the picker.
  await expect(page.getByTestId('new-container-kind')).toHaveValue('namespace');
  await selectBoth(page, 'Animal', 'Dog');
  await page.getByTestId('group-selected').click();

  const source = await dsl(page);
  expect(source).toMatch(/namespace\s+\S+\s*\{/);
  // Both classes must actually be inside the emitted block, not just present somewhere in the
  // file — search for the closing "}" starting FROM "namespace", not from 0 (the canvas.styles
  // front-matter's own "{}" empty-object literal would otherwise match first).
  const start = source.indexOf('namespace');
  const body = source.slice(start, source.indexOf('}', start) + 1);
  expect(body).toContain('class Animal');
  expect(body).toContain('class Dog');
});

test('UML: "Add Container" with Kind=Note, then renaming it, produces a real standalone "note" line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'UML Note Authoring', UML_DSL);

  await page.getByTestId('new-container-kind').selectOption('note');
  await page.getByTestId('add-container').click();

  const container = page.locator('[data-testid^="container-"]').first();
  await container.dblclick();
  const input = page.locator('[data-testid^="container-label-input-"]').first();
  await input.fill('a design note');
  await input.press('Enter');

  const source = await dsl(page);
  expect(source).toContain('note "a design note"');
});

test('UML: "Group into Container" is disabled while Kind=Note (attaches via a different mechanism than multi-node grouping)', async ({
  page,
}) => {
  await login(page);
  await importDsl(page, 'UML Note Group Disabled', UML_DSL);

  await page.getByTestId('new-container-kind').selectOption('note');
  await selectBoth(page, 'Animal', 'Dog');
  await expect(page.getByTestId('group-selected')).toBeDisabled();
});

test('C4: grouping two elements with a chosen boundary Kind produces the matching real Mermaid boundary macro', async ({
  page,
}) => {
  await login(page);
  await importDsl(page, 'C4 Boundary Authoring', C4_DSL);

  await page.getByTestId('new-container-kind').selectOption('enterprise-boundary');
  await selectBoth(page, 'user', 'sys');
  await page.getByTestId('group-selected').click();

  const source = await dsl(page);
  expect(source).toContain('Enterprise_Boundary(');
  // Same "search from the block's own start, not 0" fix as the UML namespace test above.
  const start = source.indexOf('Enterprise_Boundary');
  const body = source.slice(start, source.indexOf('}', start) + 1);
  expect(body).toContain('Person(user,');
  expect(body).toContain('System(sys,');
});

test('C4: the default Kind (no picker change) produces the generic "Boundary(" macro', async ({ page }) => {
  await login(page);
  await importDsl(page, 'C4 Default Boundary', C4_DSL);

  await expect(page.getByTestId('new-container-kind')).toHaveValue('boundary');
  await selectBoth(page, 'user', 'sys');
  await page.getByTestId('group-selected').click();

  expect(await dsl(page)).toContain('Boundary(');
});

test('sequence: no Container Kind picker is shown (only one role, applied automatically)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence No Kind Picker', SEQUENCE_DSL);
  await expect(page.getByTestId('new-container-kind')).toHaveCount(0);
});

test('sequence: grouping two participants produces a real "box ... end" participant grouping', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Box Authoring', SEQUENCE_DSL);

  await selectBoth(page, 'A', 'B');
  await page.getByTestId('group-selected').click();

  const source = await dsl(page);
  expect(source).toMatch(/box[^\n]*\n/);
  const body = source.slice(source.indexOf('box'), source.indexOf('end') + 3);
  expect(body).toContain('participant A');
  expect(body).toContain('participant B');
});

test('flowchart: no Container Kind picker is shown (no container-role concept in this family)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Flowchart No Kind Picker', 'flowchart TD\n  A[Start]\n  B[End]\n');
  await expect(page.getByTestId('new-container-kind')).toHaveCount(0);
  // The plain "Add Container" flow must still work unchanged (no role set at all).
  await page.getByTestId('add-container').click();
  const source = await dsl(page);
  expect(source).toContain('subgraph');
});
