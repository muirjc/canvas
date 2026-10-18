import { expect, test, type Page } from '@playwright/test';
import { API_BASE_URL, PROJECT_ID, addKind, applyDsl, login, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-7hp: several standard kinds can share one C4 role (e.g. six System kinds, each a different
 * approved fill). The kind is carried by Mermaid C4's named `$tags="..."` argument so the right one
 * survives save/reload and is selectable per node.
 *
 * The standard is published onto a uniquely named CUSTOM c4-family type, never a built-in one,
 * because this suite runs against the developer's real database.
 */
test.describe.configure({ mode: 'serial' });

let typeId = '';
let standardId = '';
const createdDiagramIds: string[] = [];

const systemKind = (id: string, label: string, fill: string) => ({
  id,
  label,
  shapes: ['rectangle'],
  approvedFills: [fill],
  match: { role: 'system', external: false },
});

async function setupType(page: Page) {
  const typeRes = await page.request.post(`${API_BASE_URL}/admin/diagram-types`, {
    data: {
      name: `C4 Kind Tags ${Date.now()}`,
      dslFamily: 'c4',
      personas: ['Business', 'Enterprise', 'Solution', 'Technical'],
    },
  });
  expect(typeRes.status()).toBe(201);
  typeId = (await typeRes.json()).diagramType.id as string;

  const stdRes = await page.request.post(`${API_BASE_URL}/diagram-types/${typeId}/standards`, {
    data: {
      name: 'C4 kind tags E2E',
      elementKinds: [
        systemKind('re_used', 'Re-Used', '#9ca3af'),
        systemKind('new_system', 'New', '#22c55e'),
        systemKind('retired_system', 'Retired', '#ef4444'),
      ],
    },
  });
  expect(stdRes.status()).toBe(201);
  standardId = (await stdRes.json()).standard.id as string;
  const pubRes = await page.request.post(`${API_BASE_URL}/standards/${standardId}/publish`);
  expect(pubRes.status()).toBe(200);
}

async function newTypedDiagram(page: Page): Promise<string> {
  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  const created = page.waitForResponse((r) => /\/projects\/[^/]+\/diagrams$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByTestId('new-diagram').click();
  await page.getByTestId(`diagram-type-${typeId}`).check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  const id = (await (await created).json()).diagram.id as string;
  createdDiagramIds.push(id);
  return id;
}

async function openKindPicker(page: Page, nodeId: string) {
  await page.getByTestId(`node-${nodeId}`).hover();
  await page.getByTestId(`edit-kind-${nodeId}`).click();
  return page.getByTestId(`kind-role-select-${nodeId}`);
}

test.afterAll(async ({ browser }) => {
  // Clean up: soft-delete the diagrams and retire the standard. (A custom type has no delete route.)
  const page = await browser.newPage();
  await login(page);
  for (const id of createdDiagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  if (standardId) await page.request.post(`${API_BASE_URL}/standards/${standardId}/retire`);
  await page.close();
});

test('a kind sharing its role is tagged, survives reload, and can be re-picked', async ({ page }) => {
  await login(page);
  await setupType(page);
  const diagramId = await newTypedDiagram(page);

  await expect(page.getByTestId('add-kind-new_system')).toBeVisible();
  const nodeId = await addKind(page, 'new_system');

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText(/saved/i);

  const source = await readDsl(page);
  expect(source).toMatch(new RegExp(`System\\(${nodeId},[^\\n]*\\$tags="new_system"`));
  expect(source).toMatch(/#22c55e/i);

  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId(`node-${nodeId}`)).toBeVisible();

  // Classified as new_system (not the first System kind, re_used), so its fill is not flagged.
  await page.getByTestId('rail-tab-issues').click();
  await expect(page.locator('[data-testid="violation-item"][data-rule="kind-fill"]')).toHaveCount(0);

  await expect(await openKindPicker(page, nodeId)).toHaveValue('new_system');
  await page.getByTestId(`kind-role-select-${nodeId}`).selectOption('retired_system');
  await page.getByTestId(`kind-done-${nodeId}`).click();

  await expect.poll(() => readDsl(page)).toMatch(/\$tags="retired_system"/);
  const changed = await readDsl(page);
  expect(changed).not.toContain('new_system');
  expect(changed).toMatch(/#ef4444/i);
});

test('named-arg $tags in pasted DSL applies without a parse error and selects the kind', async ({ page }) => {
  await login(page);
  await newTypedDiagram(page);

  await applyDsl(page, ['C4Context', '    System(x, "X", $tags="v1, retired_system")', ''].join('\n'));
  await expect(page.getByTestId('node-x')).toBeVisible();
  // Parse errors render in the DSL panel's unsupported-element notice (UnsupportedElementNotice).
  await expect(page.getByTestId('unsupported-element-notice')).toHaveCount(0);

  await expect(await openKindPicker(page, 'x')).toHaveValue('retired_system');
});
