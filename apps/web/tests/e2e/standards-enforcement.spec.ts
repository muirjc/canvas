import { expect, test } from '@playwright/test';
import { ensureCustomDiagramType, hideCustomDiagramType } from './diagram-type-helpers';
import { createAndPublishShapeStandard, openLegacyRules, openStandardsAdmin, publishFromEditor } from './standards-admin-helpers';
import { API_BASE_URL, login } from './standards-v2-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

// canvas-7ewa: the editor's toolbar now follows the active standard, so these specs publish onto
// their own fixed-name CUSTOM flowchart-family type instead of the built-in flowchart type (a
// rectangles-only standard left active there would take shapes away from every later spec).
test.describe.configure({ mode: 'serial' });
let typeId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  typeId = await ensureCustomDiagramType(page.request, { name: 'E2E Enforcement Flow', dslFamily: 'flowchart' });
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  const active = await page.request.get(`${API_BASE_URL}/diagram-types/${typeId}/standard`);
  const standard = active.ok() ? (await active.json()).standard : null;
  if (standard?.id) await page.request.post(`${API_BASE_URL}/standards/${standard.id}/retire`);
  await hideCustomDiagramType(page.request, typeId);
  await page.close();
});

/**
 * User Story 2 end-to-end: an admin publishes a Standard restricting the flowchart diagram type
 * to rectangles only, then a diagram using a circle is created and saved — it must save
 * successfully (soft-flag, FR-024) while the violation is specifically surfaced (FR-013).
 */
test('admin publishes a standard; a violating diagram is soft-flagged, not blocked', async ({ page }) => {
  // ?admin=true is a legacy alias that lands on the Standards page with flowchart pre-selected.
  await openStandardsAdmin(page, '/?admin=true');
  await page.getByTestId(`standards-type-${typeId}`).click();
  await createAndPublishShapeStandard(page, { name: `Rect only ${Date.now()}`, allowed: ['rectangle'] });

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId(`diagram-type-${typeId}`).check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // canvas-7ewa: the toolbar no longer offers a circle under a rectangles-only standard; typed DSL
  // still can, and that is what gets flagged.
  await expect(page.getByTestId('add-shape-circle')).toHaveCount(0);
  await page.getByTestId('rail-tab-dsl').click();
  await page.getByTestId('dsl-panel').fill('flowchart TD\n  A((Circle))\n');
  await page.getByTestId('apply-dsl').click();
  await page.getByTestId('save-diagram').click();

  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  // Violations are one panel of the editor's secondary rail (feature 005). Navigation only.
  await page.getByTestId('rail-tab-issues').click();
  await expect(page.getByTestId('violations-panel')).toBeVisible();
  await expect(page.getByTestId('violation-item').first()).toContainText('allowed-shapes');

  // Save succeeded despite the violation — soft-flag, never a hard block.
  await page.getByTestId('export-menu-trigger').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
});

/**
 * Feature 009: the admin standards editor must offer all nine new shapes as governable, even
 * though only seven have a toolbar button (research.md §5) — an admin can still mandate/allow the
 * -alt orientations. This exercises the "zero validator change needed" claim end to end rather
 * than taking it on faith: `packages/diagram-core/src/standards/validator.ts` is already generic
 * over `NodeShape`.
 */
test('admin standards editor governs the nine new shapes, including a mandatory-shape violation', async ({ page }) => {
  await openStandardsAdmin(page, '/?admin=true');
  await page.getByTestId(`standards-type-${typeId}`).click();
  await page.getByTestId('standard-new').click();
  await page.getByTestId('standard-name-input').fill(`Hexagon ${Date.now()}`);
  await openLegacyRules(page);

  const newShapes = [
    'stadium',
    'subroutine',
    'double-circle',
    'hexagon',
    'parallelogram',
    'parallelogram-alt',
    'trapezoid',
    'trapezoid-alt',
    'asymmetric',
  ];
  await page.getByTestId('authoring-shapes-listed').check();
  for (const shape of newShapes) {
    await expect(page.getByTestId(`allowed-shape-${shape}`)).toBeVisible();
    await expect(page.getByTestId(`mandatory-shape-${shape}`)).toBeVisible();
  }
  // Nothing ticked under "Only these" can't be published; this test is about mandatory shapes.
  await page.getByTestId('authoring-shapes-all').check();

  await page.getByTestId('mandatory-shape-hexagon').locator('input').check();
  await publishFromEditor(page);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId(`diagram-type-${typeId}`).check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // No hexagon added — the mandatory-shape rule should flag its absence.
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.getByTestId('rail-tab-issues').click();
  await expect(page.getByTestId('violations-panel')).toBeVisible();
  await expect(page.getByTestId('violation-item').first()).toContainText('mandatory-shapes');
});
