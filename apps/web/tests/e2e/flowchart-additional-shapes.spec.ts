import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 2 end-to-end: the seven additional Mermaid flowchart shapes (plus double-circle and
 * stadium, both already parseable but never drawn) must render as themselves — on the canvas, in
 * export, and across a save/reload round-trip — never as a generic rectangle standing in.
 */
const ADDITIONAL_SHAPES_DSL = [
  'flowchart TD',
  '  STADIUM([Stadium])',
  '  SUBROUTINE[[Subroutine]]',
  '  DBLCIRCLE(((Double Circle)))',
  '  HEX{{Hexagon}}',
  '  PARA[/Parallelogram/]',
  '  PARAALT[\\Parallelogram Alt\\]',
  '  TRAP[/Trapezoid\\]',
  '  TRAPALT[\\Trapezoid Alt/]',
  '  ASYM>Asymmetric]',
  '',
].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importAdditionalShapes(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(ADDITIONAL_SHAPES_DSL);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('imports and renders all nine additional shapes as themselves, not as rectangles', async ({ page }) => {
  await login(page);
  await importAdditionalShapes(page, 'Additional Shapes Canvas');

  await expect(page.locator('[data-testid="node-STADIUM"] rect')).toHaveAttribute('rx', '30');
  await expect(page.locator('[data-testid="node-SUBROUTINE"] rect')).toHaveCount(1);
  await expect(page.locator('[data-testid="node-SUBROUTINE"] line')).toHaveCount(2);
  await expect(page.locator('[data-testid="node-DBLCIRCLE"] ellipse')).toHaveCount(2);

  const hexPoints = await page.locator('[data-testid="node-HEX"] polygon').getAttribute('points');
  expect(hexPoints?.trim().split(/\s+/)).toHaveLength(6);

  for (const id of ['PARA', 'PARAALT', 'TRAP', 'TRAPALT']) {
    const points = await page.locator(`[data-testid="node-${id}"] polygon`).getAttribute('points');
    expect(points?.trim().split(/\s+/)).toHaveLength(4);
  }
  // parallelogram and its -alt counterpart must be visually mirrored, not identical.
  const paraPoints = await page.locator('[data-testid="node-PARA"] polygon').getAttribute('points');
  const paraAltPoints = await page.locator('[data-testid="node-PARAALT"] polygon').getAttribute('points');
  expect(paraPoints).not.toBe(paraAltPoints);

  await expect(page.locator('[data-testid="node-ASYM"] polygon')).toHaveCount(1);
  await expect(page.locator('[data-testid="node-ASYM"] rect')).toHaveCount(0);
});

test('exports the same nine distinct shapes to SVG, not rectangles standing in for them', async ({ page }) => {
  await login(page);
  await importAdditionalShapes(page, 'Additional Shapes Export');

  await page.getByTestId('export-menu-trigger').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');

  // stadium + subroutine each contribute one <rect>; only subroutine adds <line>s; only
  // double-circle adds <ellipse>s; the remaining five shapes are all <polygon>.
  expect(svg.match(/<rect/g)?.length).toBe(2);
  expect(svg.match(/<line/g)?.length).toBe(2);
  expect(svg.match(/<ellipse/g)?.length).toBe(2);
  expect(svg.match(/<polygon/g)?.length).toBe(6);
});

test('preserves every additional shape and orientation through save and reload', async ({ page }) => {
  await login(page);
  // Unique per run: a prior run's diagram of the same name would otherwise still be sitting in
  // the seeded project and make the row lookup below ambiguous (strict-mode violation).
  const diagramName = `Additional Shapes Round Trip ${Date.now()}`;
  await importAdditionalShapes(page, diagramName);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  // Leave the editor and come back through the project browser — a real reload, not in-memory state.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const row = page.locator('li.row', { hasText: diagramName });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await expect(page.locator('[data-testid="node-STADIUM"] rect')).toHaveAttribute('rx', '30');
  await expect(page.locator('[data-testid="node-SUBROUTINE"] line')).toHaveCount(2);
  await expect(page.locator('[data-testid="node-DBLCIRCLE"] ellipse')).toHaveCount(2);
  await expect(page.locator('[data-testid="node-HEX"] polygon')).toHaveCount(1);

  const paraPoints = await page.locator('[data-testid="node-PARA"] polygon').getAttribute('points');
  const paraAltPoints = await page.locator('[data-testid="node-PARAALT"] polygon').getAttribute('points');
  expect(paraPoints).not.toBe(paraAltPoints);
  const trapPoints = await page.locator('[data-testid="node-TRAP"] polygon').getAttribute('points');
  const trapAltPoints = await page.locator('[data-testid="node-TRAPALT"] polygon').getAttribute('points');
  expect(trapPoints).not.toBe(trapAltPoints);

  await expect(page.locator('[data-testid="node-ASYM"] polygon')).toHaveCount(1);
});
