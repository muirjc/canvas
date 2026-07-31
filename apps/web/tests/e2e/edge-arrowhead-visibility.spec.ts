import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-1rq: edges drawn center-to-center hide the arrowhead underneath the opaque target node
 * (nodes render on top of edges). Endpoints must clip to each node's shape boundary instead.
 *
 * Expected coordinates depend on the parser's auto-position formula (40/220 x, both default
 * DEFAULT_NODE_SIZE 140x60) and the rectangle boundary clip (right edge of A at x=180, left edge
 * of B at x=220) — see packages/diagram-core/tests/contract/render-svg.test.ts for the
 * shape-boundary math itself; this only confirms the same fix reaches the live app end to end.
 */
const ARROWHEAD_DSL = ['flowchart TD', '  A[Source] --> B[Target]', ''].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importArrowheadDiagram(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(ARROWHEAD_DSL);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('draws the edge line clipped to each node\'s boundary, not raw centers, on the canvas', async ({ page }) => {
  await login(page);
  await importArrowheadDiagram(page, 'Arrowhead Canvas');

  const line = page.locator('[data-testid^="edge-"] line');
  await expect(line).toHaveAttribute('x1', '180');
  await expect(line).toHaveAttribute('x2', '220');
});

test('exports the edge line clipped the same way as the canvas', async ({ page }) => {
  await login(page);
  await importArrowheadDiagram(page, 'Arrowhead Export');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');

  expect(svg).toMatch(/<line x1="180" y1="70" x2="220" y2="70"/);
});
