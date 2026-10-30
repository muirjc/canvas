import { expect, test } from '@playwright/test';
import { ensureCustomDiagramType, hideCustomDiagramType } from './diagram-type-helpers';
import { API_BASE_URL, PROJECT_ID, addKind, login, newDiagram } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-thia: "one Component per diagram, whether New, Reused or Retired" -- a kind group's Max
 * count spans several kinds. The admin defines it in the standards editor; the canvas then refuses a
 * second member of the group. Uses a fixed-name CUSTOM type, never a built-in one.
 */
test.describe.configure({ mode: 'serial' });

let typeId = '';
let standardId = '';
const diagramIds: string[] = [];

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  typeId = await ensureCustomDiagramType(page.request, { name: 'E2E Kind Group Flow', dslFamily: 'flowchart' });
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  for (const id of diagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  if (standardId) await page.request.post(`${API_BASE_URL}/standards/${standardId}/retire`);
  await hideCustomDiagramType(page.request, typeId);
  await page.close();
});

test('an admin groups kinds in the standards editor, and saving keeps the group', async ({ page }) => {
  await login(page);
  const res = await page.request.post(`${API_BASE_URL}/diagram-types/${typeId}/standards`, {
    data: {
      name: `Kind groups ${Date.now()}`,
      elementKinds: [
        { id: 'new_component', label: 'New Component', shapes: ['rectangle'], approvedFills: ['#dcfce7'] },
        { id: 'retired_component', label: 'Retired Component', shapes: ['rectangle'], approvedFills: ['#fee2e2'] },
        { id: 'consumer', label: 'Consumer', shapes: ['rounded-rectangle'], approvedFills: ['#fef3c7'] },
      ],
    },
  });
  expect(res.status()).toBe(201);
  standardId = (await res.json()).standard.id as string;

  await page.goto(`/?admin=standards`);
  await page.getByTestId(`standards-type-${typeId}`).click();
  await page.getByTestId(`standard-edit-${standardId}`).click();
  const groups = page.getByTestId('kind-groups');
  await groups.getByTestId('kind-group-add').click();
  await groups.getByTestId('kind-group-label-0').fill('Component');
  await groups.getByTestId('kind-group-0-kind-new_component').check();
  await groups.getByTestId('kind-group-0-kind-retired_component').check();
  await expect(groups.getByTestId('kind-group-max-0')).toHaveValue('1');
  const saved = page.waitForResponse((r) => r.url().includes(`/standards/${standardId}`) && r.request().method() === 'PUT');
  await page.getByTestId('standard-save').click();
  expect((await saved).status()).toBe(200);

  const stored = await (await page.request.get(`${API_BASE_URL}/diagram-types/${typeId}/standards`)).json();
  const rules = stored.standards.find((s: { id: string }) => s.id === standardId).rules;
  expect(rules.kindGroups).toEqual([{ id: 'component', label: 'Component', kindIds: ['new_component', 'retired_component'], maxCount: 1 }]);
  expect((await page.request.post(`${API_BASE_URL}/standards/${standardId}/publish`)).status()).toBe(200);
});

test('a full kind group blocks adding any of its kinds', async ({ page }) => {
  await login(page);
  const created = page.waitForResponse((r) => /\/projects\/[^/]+\/diagrams$/.test(r.url()) && r.request().method() === 'POST');
  await newDiagram(page, typeId);
  diagramIds.push((await (await created).json()).diagram.id as string);

  await addKind(page, 'new_component');
  const retired = page.getByTestId('add-kind-retired_component');
  await expect(retired).toBeDisabled();
  await expect(retired).toHaveAttribute('title', 'This diagram already has its 1 Component (New Component or Retired Component).');
  await expect(page.getByTestId('add-kind-new_component')).toBeDisabled();
  await expect(page.getByTestId('add-kind-consumer')).toBeEnabled();
});
