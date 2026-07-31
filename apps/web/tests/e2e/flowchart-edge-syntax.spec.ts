import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Grouping B (docs/flowchart-completeness-brief.md): dotted, thick, no-arrowhead, bidirectional,
 * invisible, chained, and fan-out edges must import, render distinctly on the canvas and in
 * export, and survive a save/reload round-trip — the same three checks feature 009 used for node
 * shapes, applied to edge/link syntax instead.
 */
const EDGE_SYNTAX_DSL = [
  'flowchart TD',
  '  A[Solid] --> B[Solid Target]',
  '  C[Dotted] -.-> D[Dotted Target]',
  '  E[Thick] ==> F[Thick Target]',
  '  G[NoArrow] --- H[NoArrow Target]',
  '  I[Bidirectional] <--> J[Bidirectional Target]',
  '  K[Invisible] ~~~ L[Invisible Target]',
  '  M[ChainStart] --> N[ChainMid] --> O[ChainEnd]',
  '  P[FanSource] --> Q[FanA] & R[FanB]',
  '',
].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importEdgeSyntaxDiagram(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(EDGE_SYNTAX_DSL);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('imports and renders every additional edge/link syntax distinctly on the canvas', async ({ page }) => {
  await login(page);
  await importEdgeSyntaxDiagram(page, 'Edge Syntax Canvas');

  // 8 declared edges + 1 chain hop (M->N->O is 2 edges) + 1 fan-out hop (P->Q, P->R is 2 edges)
  // = 6 plain declarations (1 edge each) + chain (2) + fan-out (2) = 10 total edges.
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(10);

  await expect(page.locator('[data-testid^="edge-"] line[stroke-dasharray]').first()).toHaveCount(1);

  const invisibleLine = page.locator('[data-testid^="edge-"] line[stroke="none"]');
  await expect(invisibleLine).toHaveCount(1);

  const bidirectional = page.locator('[data-testid^="edge-"] line[marker-start]');
  await expect(bidirectional).toHaveCount(1);
});

test('exports every additional edge/link syntax with the same distinct rendering', async ({ page }) => {
  await login(page);
  await importEdgeSyntaxDiagram(page, 'Edge Syntax Export');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');

  expect(svg.match(/<line[^>]*stroke-dasharray/g)?.length).toBeGreaterThanOrEqual(1);
  expect(svg.match(/<line[^>]*stroke="none"/g)?.length).toBe(1);
  expect(svg.match(/marker-start/g)?.length).toBe(1);
  // No-arrow (---) edge: a <line> with neither marker-start nor marker-end.
  expect(svg).toMatch(/<line(?:(?!marker)[^>])*\/>/);
});

test('preserves the DSL for every additional edge/link syntax construct through save and reload', async ({ page }) => {
  await login(page);
  const diagramName = `Edge Syntax Round Trip ${Date.now()}`;
  await importEdgeSyntaxDiagram(page, diagramName);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const row = page.locator('li.row', { hasText: diagramName });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('-.->');
  expect(dsl).toContain('==>');
  expect(dsl).toContain('---');
  expect(dsl).toContain('<-->');
  expect(dsl).toContain('~~~');
  // Chain/fan-out are canonicalized to separate plain edges on serialize, not re-compressed —
  // confirm both expanded hops are present rather than the original compressed syntax.
  expect(dsl).toContain('N --> O');
  expect((dsl.match(/P -->/g) ?? []).length).toBe(2);
});
