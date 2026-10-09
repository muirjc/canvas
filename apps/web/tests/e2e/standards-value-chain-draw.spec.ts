import { expect, test } from '@playwright/test';
import { PROJECT_ID, addKind, login, newDiagram, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/** Standards v2 DRAW channel, against the seeded Value Chain reference standard. */
test('value chain: kind toolbar, live issues, kind styling, connector policy, selection, persistence', async ({ page }) => {
  await login(page);
  const created = page.waitForResponse((r) => /\/projects\/[^/]+\/diagrams$/.test(r.url()) && r.request().method() === 'POST');
  await newDiagram(page, 'value-chain');
  const diagramId = (await (await created).json()).diagram.id as string;

  // Kind toolbar replaces the free shape grid.
  await expect(page.getByTestId('kind-toolbar')).toBeVisible();
  for (const k of ['primary_activity', 'support_activity', 'margin']) {
    await expect(page.getByTestId(`add-kind-${k}`)).toBeVisible();
  }
  await expect(page.locator('[data-testid^="add-shape-"]')).toHaveCount(0);

  // Live (unsaved) min-count errors.
  await page.getByTestId('rail-tab-issues').click();
  const minCount = page.locator('[data-testid="violation-item"][data-rule="kind-min-count"]');
  await expect(minCount).toHaveCount(3);

  const primary = await addKind(page, 'primary_activity');
  await expect(minCount).toHaveCount(2);
  const support = await addKind(page, 'support_activity');
  await expect(minCount).toHaveCount(1);
  const margin = await addKind(page, 'margin');
  await expect(minCount).toHaveCount(0);

  // DSL carries the kind class.
  expect(await readDsl(page)).toContain(':::primary_activity');

  // Style popup shows only approved swatches.
  await page.getByTestId(`node-${primary}`).hover();
  await page.getByTestId(`edit-style-${primary}`).click();
  await expect(page.getByTestId(`style-fill-swatches-${primary}`)).toBeVisible();
  await expect(page.locator(`[data-testid^="style-fill-swatch-${primary}-"]`)).toHaveCount(2);
  await expect(page.getByTestId(`style-fill-input-${primary}`)).toHaveCount(0);
  await page.getByTestId(`style-fill-swatch-${primary}-bfdbfe`).click();
  await page.getByTestId(`style-done-${primary}`).click();
  await expect.poll(() => readDsl(page)).toMatch(/#bfdbfe/i);

  // Clicking a violation selects that node on the canvas (an unconnected primary_activity is flagged).
  await page.getByTestId('rail-tab-issues').click();
  await page.getByTestId(`violation-select-${primary}`).first().click();
  await expect(page.getByTestId(`node-${primary}`).locator('[stroke="#2874a6"]').first()).toBeVisible();
  await expect(page.getByTestId(`node-${support}`).locator('[stroke="#2874a6"]')).toHaveCount(0);

  // Connector policy: support -> margin refused.
  const edges = page.locator('[data-testid^="edge-"]');
  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId(`node-${support}`).click();
  await page.getByTestId(`node-${margin}`).click();
  await expect(page.getByTestId('connect-notice')).toBeVisible();
  await expect(edges).toHaveCount(0);

  // primary -> margin allowed.
  await page.getByTestId(`node-${primary}`).click();
  await page.getByTestId(`node-${margin}`).click();
  await expect(edges).toHaveCount(1);

  // Save + reload.
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText(/saved/i);
  // A reload lands on the project browser (no diagram id in the URL), so reopen the diagram.
  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  expect(await readDsl(page)).toContain(':::primary_activity');
  await page.getByTestId(`node-${primary}`).hover();
  await page.getByTestId(`edit-style-${primary}`).click();
  await expect(page.getByTestId(`style-fill-swatch-${primary}-bfdbfe`)).toHaveAttribute('aria-checked', 'true');
});
