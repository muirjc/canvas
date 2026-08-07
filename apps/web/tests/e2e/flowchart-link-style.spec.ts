import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Mermaid's `linkStyle` directive styles an edge by its 0-based declaration order. Must render on
 * the canvas, in export, and survive a save/reload round-trip — the same three checks feature 009
 * used for node shapes, applied to edge styling instead.
 */
const LINK_STYLE_DSL = [
  'flowchart TD',
  '  A[Start] --> B[Middle]',
  '  B --> C[End]',
  '  linkStyle 0 stroke:#ff0000,stroke-width:4px,stroke-dasharray:5 5',
  '',
].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importLinkStyleDiagram(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(LINK_STYLE_DSL);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('renders a linkStyle-targeted edge with its color/width/dash on the canvas, not the default', async ({ page }) => {
  await login(page);
  await importLinkStyleDiagram(page, 'Link Style Canvas');

  const styledEdge = page.locator('[data-testid^="edge-"] line[stroke="#ff0000"]');
  await expect(styledEdge).toHaveAttribute('stroke-width', '4');
  await expect(styledEdge).toHaveAttribute('stroke-dasharray', '5 5');

  // The second edge (B --> C) was never targeted by linkStyle — must keep the default stroke.
  const unstyledEdges = page.locator('[data-testid^="edge-"] line[stroke="#333"]');
  await expect(unstyledEdges).toHaveCount(1);
});

test('exports the linkStyle-targeted edge with the same color/width/dash', async ({ page }) => {
  await login(page);
  await importLinkStyleDiagram(page, 'Link Style Export');

  await page.getByTestId('export-menu-trigger').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');

  expect(svg).toMatch(/<line[^>]*stroke="#ff0000"[^>]*stroke-width="4"[^>]*stroke-dasharray="5 5"/);
});

test('preserves the edge style through save and reload', async ({ page }) => {
  await login(page);
  const diagramName = `Link Style Round Trip ${Date.now()}`;
  await importLinkStyleDiagram(page, diagramName);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const row = page.locator('li.row', { hasText: diagramName });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const styledEdge = page.locator('[data-testid^="edge-"] line[stroke="#ff0000"]');
  await expect(styledEdge).toHaveAttribute('stroke-width', '4');
  await expect(styledEdge).toHaveAttribute('stroke-dasharray', '5 5');
});
