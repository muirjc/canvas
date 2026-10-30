import { expect, test, type Page } from '@playwright/test';
import { ensureCustomDiagramType, hideCustomDiagramType } from './diagram-type-helpers';
import { publishFromEditor } from './standards-admin-helpers';
import { API_BASE_URL, PROJECT_ID, login, newDiagram, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-7ewa / canvas-wid / canvas-8hi9: a standard's "What authors can add" decides which shapes,
 * icons and (for architecture) built-in service buttons the editor offers. Uses fixed-name CUSTOM
 * types (never built-in ones), each with its own palette libraries.
 */
test.describe.configure({ mode: 'serial' });

let flowType = '';
let archType = '';
const standardIds: string[] = [];
const diagramIds: string[] = [];

async function publishStandard(page: Page, typeId: string, body: Record<string, unknown>) {
  const res = await page.request.post(`${API_BASE_URL}/diagram-types/${typeId}/standards`, { data: { name: `Authoring ${Date.now()}`, ...body } });
  expect(res.status()).toBe(201);
  const id = (await res.json()).standard.id as string;
  standardIds.push(id);
  expect((await page.request.post(`${API_BASE_URL}/standards/${id}/publish`)).status()).toBe(200);
}

async function retireActive(page: Page, typeId: string) {
  const active = await page.request.get(`${API_BASE_URL}/diagram-types/${typeId}/standard`);
  const standard = active.ok() ? (await active.json()).standard : null;
  if (standard?.id) await page.request.post(`${API_BASE_URL}/standards/${standard.id}/retire`);
}

async function openNew(page: Page, typeId: string) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  const created = page.waitForResponse((r) => /\/projects\/[^/]+\/diagrams$/.test(r.url()) && r.request().method() === 'POST');
  await newDiagram(page, typeId);
  diagramIds.push((await (await created).json()).diagram.id as string);
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  flowType = await ensureCustomDiagramType(page.request, { name: 'E2E Authoring Flow', dslFamily: 'flowchart' });
  archType = await ensureCustomDiagramType(page.request, { name: 'E2E Authoring Arch', dslFamily: 'architecture' });
  for (const [id, libs] of [
    [flowType, ['generic', 'azure-icons']],
    [archType, ['mermaid-architecture', 'azure-icons']],
  ] as const) {
    expect((await page.request.patch(`${API_BASE_URL}/admin/diagram-types/${id}`, { data: { paletteLibraryIds: libs } })).ok()).toBe(true);
    await retireActive(page, id);
  }
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  for (const id of diagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  for (const id of standardIds) await page.request.post(`${API_BASE_URL}/standards/${id}/retire`);
  await hideCustomDiagramType(page.request, flowType);
  await hideCustomDiagramType(page.request, archType);
  await page.close();
});

const KINDS = [{ id: 'step', label: 'Step', shapes: ['rectangle'], approvedFills: ['#dbeafe'] }];

test('only the listed shapes, and no Palette when icons are off', async ({ page }) => {
  await login(page);
  await publishStandard(page, flowType, { elementKinds: KINDS, allowedShapeIds: ['diamond'], authoring: { shapes: 'listed', icons: 'none' } });
  await openNew(page, flowType);

  await expect(page.getByTestId('add-kind-step')).toBeVisible();
  await expect(page.getByTestId('add-shape-diamond')).toBeVisible();
  await expect(page.getByTestId('add-shape-rectangle')).toHaveCount(0);
  // Icons are off and shapes aren't "All", so not even the generic shape-alias entries remain.
  await expect(page.getByTestId('palette-search')).toHaveCount(0);
});

test('kinds only: no Shapes and no Palette (canvas-wid)', async ({ page }) => {
  await login(page);
  await publishStandard(page, flowType, { elementKinds: KINDS, requireKnownKinds: true });
  await openNew(page, flowType);

  await expect(page.getByTestId('add-kind-step')).toBeVisible();
  await expect(page.locator('[data-testid^="add-shape-"]')).toHaveCount(0);
  await expect(page.getByTestId('palette-search')).toHaveCount(0);
});

test('icons limited to the listed library', async ({ page }) => {
  await login(page);
  await publishStandard(page, flowType, {
    elementKinds: KINDS,
    allowedIconLibraryRefs: [{ libraryId: 'azure-icons', libraryVersion: 'any' }],
    authoring: { shapes: 'none', icons: 'listed' },
  });
  await openNew(page, flowType);

  await expect(page.locator('[data-testid^="add-shape-"]')).toHaveCount(0);
  await page.getByTestId('palette-search').fill('storage');
  const tiles = page.locator('[data-testid^="palette-icon-"]');
  await expect(tiles.first()).toBeVisible();
  const ids = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(ids.every((id) => id!.startsWith('palette-icon-azure-icons-'))).toBe(true);
});

test('architecture: built-in Services buttons add a service, unless icons exclude them (canvas-8hi9)', async ({ page }) => {
  await login(page);
  await openNew(page, archType);
  await expect(page.getByTestId('service-toolbar')).toBeVisible();
  await page.getByTestId('add-service-database').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  expect(await readDsl(page)).toMatch(/service \S+\(database\)\[Database\]/);

  await publishStandard(page, archType, { allowedIconLibraryRefs: [{ libraryId: 'azure-icons', libraryVersion: 'any' }], authoring: { icons: 'listed' } });
  await openNew(page, archType);
  await expect(page.getByTestId('add-junction')).toBeVisible();
  await expect(page.getByTestId('service-toolbar')).toHaveCount(0);
});

test('the standards editor saves "What authors can add"', async ({ page }) => {
  await login(page);
  await page.goto('/?admin=standards');
  await page.getByTestId(`standards-type-${flowType}`).click();
  await page.getByTestId('standard-new').click();
  await page.getByTestId('standard-name-input').fill(`Authoring UI ${Date.now()}`);
  await page.getByTestId('authoring-shapes-none').check();
  await page.getByTestId('authoring-icons-listed').check();
  await page.getByTestId('allowed-icon-library-azure-icons').locator('input').check();
  await publishFromEditor(page);

  const active = (await (await page.request.get(`${API_BASE_URL}/diagram-types/${flowType}/standard`)).json()).standard;
  standardIds.push(active.id);
  expect(active.rules.authoring).toEqual({ shapes: 'none', icons: 'listed' });
  expect(active.rules.allowedIconLibraryRefs.map((r: { libraryId: string }) => r.libraryId)).toEqual(['azure-icons']);
});
