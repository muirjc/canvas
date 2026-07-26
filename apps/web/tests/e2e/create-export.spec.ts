import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 1 end-to-end: create a diagram, edit it via the canvas and the DSL panel, and
 * export it. Exercises the full stack (web -> api -> diagram-core -> Postgres).
 */
test('create, edit, and export a diagram', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);

  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();

  await page.waitForURL('**/*');
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // Acceptance Scenario 1: add shapes/connectors via the canvas, DSL updates.
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('add-shape-circle').click();

  const dslPanel = page.getByTestId('dsl-panel');
  await expect(dslPanel).toContainText('flowchart TD');
  await expect(dslPanel).toContainText('New Node');

  // Acceptance Scenario 2: editing the DSL directly updates the canvas.
  const currentDsl = await dslPanel.inputValue();
  const editedDsl = currentDsl.replace(/flowchart TD/, 'flowchart TD\n  Z[Added Via DSL]');
  await dslPanel.fill(editedDsl);
  await page.getByTestId('apply-dsl').click();
  await expect(page.getByTestId('node-Z')).toBeVisible();

  // Save, then Acceptance Scenario 3: export in all three formats.
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  const [mermaidDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-mermaid').click(),
  ]);
  expect(mermaidDownload.suggestedFilename()).toMatch(/\.mmd$/);

  const [svgDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-svg').click(),
  ]);
  expect(svgDownload.suggestedFilename()).toMatch(/\.svg$/);

  const [pngDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-png').click(),
  ]);
  expect(pngDownload.suggestedFilename()).toMatch(/\.png$/);
});
