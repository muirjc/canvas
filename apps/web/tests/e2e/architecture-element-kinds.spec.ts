import { expect, test, type Page } from '@playwright/test';
import { API_BASE_URL, PROJECT_ID, addKind, applyDsl, login, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * jmuir-dtu.28: a standard's element kinds now also drive architecture-beta diagrams. A service's
 * kind is node.role, persisted in front-matter as `canvas.kinds`, its fill in `canvas.styles`.
 *
 * The standard is published onto a uniquely named CUSTOM architecture-family type, never a built-in
 * one, because this suite runs against the developer's real database.
 */
const ARCH_DSL = ['architecture-beta', '    service a(server)[A]', '    junction j', ''].join('\n');

test.describe.configure({ mode: 'serial' });

let typeId = '';
let standardId = '';
const createdDiagramIds: string[] = [];

async function setupType(page: Page) {
  const typeRes = await page.request.post(`${API_BASE_URL}/admin/diagram-types`, {
    data: {
      name: `Arch Kinds ${Date.now()}`,
      dslFamily: 'architecture',
      personas: ['Business', 'Enterprise', 'Solution', 'Technical'],
    },
  });
  expect(typeRes.status()).toBe(201);
  typeId = (await typeRes.json()).diagramType.id as string;

  const stdRes = await page.request.post(`${API_BASE_URL}/diagram-types/${typeId}/standards`, {
    data: {
      name: 'Architecture kinds E2E',
      elementKinds: [
        { id: 'core_service', label: 'Core Service', shapes: [], approvedFills: ['#dbeafe'] },
        { id: 'third_party', label: 'Third Party', shapes: ['icon'], approvedFills: ['#fde68a'] },
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

test.afterAll(async ({ browser }) => {
  // Clean up: soft-delete the diagrams and retire the standard. (A custom type has no delete route.)
  const page = await browser.newPage();
  await login(page);
  for (const id of createdDiagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  if (standardId) await page.request.post(`${API_BASE_URL}/standards/${standardId}/retire`);
  await page.close();
});

test('adding a kind via the toolbar persists canvas.kinds + fill, surviving reload', async ({ page }) => {
  await login(page);
  await setupType(page);
  const diagramId = await newTypedDiagram(page);

  await expect(page.getByTestId('kind-toolbar')).toBeVisible();
  await expect(page.getByTestId('add-kind-core_service')).toBeVisible();
  const nodeId = await addKind(page, 'third_party');

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText(/saved/i);

  const source = await readDsl(page);
  expect(source).toMatch(new RegExp(`kinds:[\\s\\S]*${nodeId}: third_party`));
  expect(source).toMatch(/#fde68a/i);

  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId(`node-${nodeId}`)).toBeVisible();
  expect(await readDsl(page)).toMatch(new RegExp(`${nodeId}: third_party`));

  await page.getByTestId(`node-${nodeId}`).hover();
  await page.getByTestId(`edit-kind-${nodeId}`).click();
  await expect(page.getByTestId(`kind-role-select-${nodeId}`)).toHaveValue('third_party');
});

test('the kind picker works on an imported service and is absent on a junction', async ({ page }) => {
  await login(page);
  await newTypedDiagram(page);
  await applyDsl(page, ARCH_DSL);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  await page.getByTestId('node-j').hover();
  await expect(page.getByTestId('node-j')).toBeVisible();
  await expect(page.getByTestId('edit-kind-j')).toHaveCount(0);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-kind-a').click();
  await page.getByTestId('kind-role-select-a').selectOption('core_service');
  await page.getByTestId('kind-done-a').click();

  const source = await readDsl(page);
  expect(source).toMatch(/\ba: core_service/);
  expect(source).toMatch(/#dbeafe/i);
});
