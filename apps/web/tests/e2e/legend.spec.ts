import { expect, test, type Page } from '@playwright/test';
import { ensureCustomDiagramType, hideCustomDiagramType } from './diagram-type-helpers';
import { API_BASE_URL, PROJECT_ID, addKind, login, newDiagram, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-ltk part 2: the diagram legend's editor UI. Automatic entries need a standard, so that
 * test publishes one onto a fixed-name CUSTOM flowchart-family type (never a built-in one).
 */
test.describe.configure({ mode: 'serial' });

let typeId = '';
let bareTypeId = '';
let standardId = '';
const createdDiagramIds: string[] = [];

async function createDiagram(page: Page, type: string) {
  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  const created = page.waitForResponse((r) => /\/projects\/[^/]+\/diagrams$/.test(r.url()) && r.request().method() === 'POST');
  await newDiagram(page, type);
  createdDiagramIds.push((await (await created).json()).diagram.id as string);
}

async function save(page: Page) {
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  for (const id of createdDiagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  if (standardId) await page.request.post(`${API_BASE_URL}/standards/${standardId}/retire`);
  await hideCustomDiagramType(page.request, typeId);
  await hideCustomDiagramType(page.request, bareTypeId);
  await page.close();
});

test('legend: toggle, add an entry, drag, save, reload, off and on', async ({ page }) => {
  await login(page);
  // A custom type with no standard, so only the author's own entries can appear.
  bareTypeId = await ensureCustomDiagramType(page.request, { name: 'E2E Legend Bare', dslFamily: 'flowchart' });
  await createDiagram(page, bareTypeId);
  await expect(page.getByTestId('diagram-legend')).toHaveCount(0);

  await page.getByTestId('legend-toggle').click();
  await expect(page.getByTestId('legend-toggle')).toHaveAttribute('aria-pressed', 'true');
  // No standard and no entries yet: nothing to draw, and the editor says so.
  await expect(page.getByTestId('legend-empty-note')).toBeVisible();

  await page.getByTestId('legend-edit').click();
  await expect(page.getByTestId('legend-editor')).toBeVisible();
  await expect(page.getByTestId('legend-no-standard')).toBeVisible();
  await page.getByTestId('legend-title').fill('Key');
  await page.getByTestId('legend-add-entry').click();
  await page.getByTestId('legend-extra-0-label').fill('Manual step');
  await page.getByTestId('legend-add-entry').click();
  await page.getByTestId('legend-extra-1-label').fill('Async call');
  await page.getByTestId('legend-extra-1-type').selectOption('line');
  await page.getByTestId('legend-extra-1-linestyle').selectOption('dotted');
  await page.getByTestId('legend-done').click();

  const legend = page.getByTestId('diagram-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Key');
  await expect(legend).toContainText('Manual step');
  await expect(legend).toContainText('Async call');
  expect(await readDsl(page)).toContain('legend:');

  // Drag it: the saved position changes.
  const before = await readDsl(page);
  const box = (await legend.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 6 + 80, { steps: 5 });
  await page.mouse.up();
  const after = await readDsl(page);
  expect(after).toContain('position');
  expect(after).not.toBe(before);
  const moved = (await legend.boundingBox())!;
  expect(Math.round(moved.x - box.x)).toBeGreaterThanOrEqual(55);
  expect(Math.round(moved.y - box.y)).toBeGreaterThanOrEqual(75);

  // Delete never removes the legend.
  await page.getByTestId('canvas-root').focus();
  await page.keyboard.press('Delete');
  await expect(legend).toBeVisible();

  await save(page);
  await page.reload();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('diagram-legend')).toContainText('Manual step');
  const reloaded = (await page.getByTestId('diagram-legend').boundingBox())!;
  expect(Math.abs(reloaded.x - moved.x)).toBeLessThan(2);

  // Off hides it but keeps the entries; on restores it.
  await page.getByTestId('legend-toggle').click();
  await expect(page.getByTestId('diagram-legend')).toHaveCount(0);
  await expect(page.getByTestId('legend-edit')).toHaveCount(0);
  await page.getByTestId('legend-toggle').click();
  await expect(page.getByTestId('diagram-legend')).toContainText('Async call');

  // Removing an entry takes it off the box.
  await page.getByTestId('legend-edit').click();
  await page.getByTestId('legend-extra-0-remove').click();
  await page.getByTestId('legend-done').click();
  await expect(page.getByTestId('diagram-legend')).not.toContainText('Manual step');
});

test('legend: automatic entries from the standard can be hidden and renamed', async ({ page }) => {
  await login(page);
  typeId = await ensureCustomDiagramType(page.request, { name: 'E2E Legend Flow', dslFamily: 'flowchart' });
  const stdRes = await page.request.post(`${API_BASE_URL}/diagram-types/${typeId}/standards`, {
    data: {
      name: 'Legend E2E',
      elementKinds: [
        { id: 'legend_step', label: 'Process Step', shapes: [], approvedFills: ['#dbeafe'] },
        { id: 'legend_store', label: 'Data Store', shapes: [], approvedFills: ['#fde68a'] },
      ],
    },
  });
  expect(stdRes.status()).toBe(201);
  standardId = (await stdRes.json()).standard.id as string;
  expect((await page.request.post(`${API_BASE_URL}/standards/${standardId}/publish`)).status()).toBe(200);

  await createDiagram(page, typeId);
  await addKind(page, 'legend_step');
  await addKind(page, 'legend_store');
  await page.getByTestId('legend-toggle').click();

  const legend = page.getByTestId('diagram-legend');
  await expect(legend).toBeVisible();
  await expect(page.getByTestId('diagram-legend-row-kind:legend_step')).toContainText('Process Step');
  await expect(page.getByTestId('diagram-legend-row-kind:legend_store')).toContainText('Data Store');

  await legend.dblclick();
  await expect(page.getByTestId('legend-editor')).toBeVisible();
  await page.getByTestId('legend-auto-kind:legend_step-label').fill('Step');
  await page.getByTestId('legend-auto-kind:legend_store-show').uncheck();
  await page.getByTestId('legend-done').click();
  await expect(page.getByTestId('diagram-legend-row-kind:legend_step')).toContainText('Step');
  await expect(page.getByTestId('diagram-legend-row-kind:legend_store')).toHaveCount(0);
  const dsl = await readDsl(page);
  expect(dsl).toContain('legend:');
  expect(dsl).toContain('legend_store');

  // Clearing the label restores the standard's; re-checking Show brings the entry back.
  await page.getByTestId('legend-edit').click();
  await page.getByTestId('legend-auto-kind:legend_step-label').fill('');
  await page.getByTestId('legend-auto-kind:legend_store-show').check();
  await page.getByTestId('legend-done').click();
  await expect(page.getByTestId('diagram-legend-row-kind:legend_step')).toContainText('Process Step');
  await expect(page.getByTestId('diagram-legend-row-kind:legend_store')).toBeVisible();
});

test('legend: a sequence diagram has no Legend toggle', async ({ page }) => {
  await login(page);
  await createDiagram(page, 'sequence');
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('legend-toggle')).toHaveCount(0);
});
