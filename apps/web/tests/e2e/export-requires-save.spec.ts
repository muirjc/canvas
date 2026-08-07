import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-uaq: export always reads the diagram's last-SAVED dslContent from the server, never live
 * editor state. Exporting right after adding shapes but before Save silently downloaded stale
 * content — a freshly-created diagram's export was just its empty initial template, and SVG/PNG
 * came out technically valid but completely blank, with no warning at all. The `export-menu-trigger`
 * (canvas-23t.5: the three format buttons are now inside a dropdown it opens, no longer disabled
 * individually) is disabled — with an explanatory tooltip — while there are unsaved changes, and a
 * visible `export-unsaved-warning` explains why — turning a silent, confusing gap into a one-click
 * fix (Save sits right next to Export already).
 */
test('export is disabled with unsaved changes and a warning shown; re-enabled and correct once saved', async ({
  page,
}) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const trigger = page.getByTestId('export-menu-trigger');
  const menuList = page.getByTestId('export-menu-list');

  // A brand-new diagram starts with nothing unsaved yet to lose — the export trigger should be
  // enabled and no warning shown, and opening it reveals all three formats.
  await expect(page.getByTestId('export-unsaved-warning')).not.toBeVisible();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(menuList).toBeVisible();
  await expect(page.getByTestId('export-mermaid')).toBeVisible();
  await expect(page.getByTestId('export-svg')).toBeVisible();
  await expect(page.getByTestId('export-png')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuList).not.toBeVisible();

  // Make an edit without saving — the exact scenario that used to silently export stale/blank
  // content.
  await page.getByTestId('add-shape-rectangle').click();

  const warning = page.getByTestId('export-unsaved-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText('Save to enable export');

  await expect(trigger).toBeDisabled();
  await expect(trigger).toHaveAttribute(
    'title',
    "Save your changes first — export always reflects the diagram's last saved version.",
  );

  // Clicking a disabled trigger is a no-op — the menu can't be opened at all while unsaved.
  await trigger.click({ force: true });
  await expect(menuList).not.toBeVisible();

  // Save — export re-enables and the warning disappears.
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await expect(warning).not.toBeVisible();
  await expect(trigger).toBeEnabled();

  // A real export now succeeds and reflects the saved shape, not stale/blank content.
  await trigger.click();
  await expect(menuList).toBeVisible();
  const [svgDownload] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  await expect(menuList).not.toBeVisible();
  const path = await svgDownload.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');
  expect(svg).toContain('<svg');
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  expect(svg.match(/<rect/g)?.length).toBeGreaterThanOrEqual(1);

  await trigger.click();
  await expect(menuList).toBeVisible();
  const [mermaidDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-mermaid').click(),
  ]);
  const mermaidPath = await mermaidDownload.path();
  expect(mermaidPath).not.toBeNull();
  const mermaid = readFileSync(mermaidPath!, 'utf-8');
  expect(mermaid).toContain('flowchart TD');
  expect(mermaid).toContain('New Node');
});
