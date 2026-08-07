import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Grouping F (docs/flowchart-completeness-brief.md): a `<br/>` in a node/edge label must render
 * as an actual line break (stacked `<tspan>`s) on the canvas and in export, and the label text
 * (including the literal `<br/>`) must survive a save/reload round-trip unchanged — this is a
 * rendering-only change, the label itself already round-tripped before this grouping.
 */
const MULTILINE_DSL = [
  'flowchart TD',
  '  A[Line one<br/>Line two] --> B[Plain]',
  '',
].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importMultilineDiagram(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(MULTILINE_DSL);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('renders a <br/>-containing label as two stacked lines, not literal text', async ({ page }) => {
  await login(page);
  await importMultilineDiagram(page, 'Multiline Canvas');

  const node = page.locator('[data-testid="node-A"]');
  await expect(node.locator('tspan')).toHaveCount(2);
  await expect(node.locator('tspan').first()).toHaveText('Line one');
  await expect(node.locator('tspan').nth(1)).toHaveText('Line two');
  await expect(node.locator('text')).not.toContainText('<br');
});

test('exports the <br/>-containing label as two stacked tspans', async ({ page }) => {
  await login(page);
  await importMultilineDiagram(page, 'Multiline Export');

  await page.getByTestId('export-menu-trigger').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');

  expect(svg).toMatch(/<tspan[^>]*>Line one<\/tspan>/);
  expect(svg).toMatch(/<tspan[^>]*>Line two<\/tspan>/);
});

test('preserves the literal <br/> in the label DSL through save and reload', async ({ page }) => {
  await login(page);
  const diagramName = `Multiline Round Trip ${Date.now()}`;
  await importMultilineDiagram(page, diagramName);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const row = page.locator('li.row', { hasText: diagramName });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('Line one<br/>Line two');

  const node = page.locator('[data-testid="node-A"]');
  await expect(node.locator('tspan')).toHaveCount(2);
});
