import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2ut: ER relationship cardinality (crow's-foot notation) was parsed by the DSL but then
 * completely discarded — every erDiagram relationship rendered as a generic plain arrowhead, and
 * silently normalized to the default one-to-many token on every re-save regardless of what was
 * actually specified. Confirms the fix actually reaches the interactive canvas via a real import
 * (not just the export renderer, covered separately by packages/diagram-core's own contract
 * tests): crow's-foot glyphs render, and the generic arrowhead marker is gone.
 */
const ERD_DSL = ['erDiagram', '  CUSTOMER ||--o{ ORDER : places', ''].join('\n');

const ERD_DASHED_MANY_TO_MANY_DSL = ['erDiagram', '  CUSTOMER }|..|{ PRODUCT : uses', ''].join('\n');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importDsl(page: import('@playwright/test').Page, name: string, dsl: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(dsl);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('renders crow\'s-foot cardinality glyphs for a one-to-many relationship, with no arrowhead marker', async ({
  page,
}) => {
  await login(page);
  await importDsl(page, 'ERD Cardinality Rendering', ERD_DSL);

  // Single relationship in this DSL parses as the diagram's first (and only) edge, "e1".
  const edge = page.locator('[data-testid="edge-e1"]');
  await expect(edge).toBeVisible();

  // Source '||' (two ticks) + target 'o{' read nearest-node-first from the ORDER end as '{o'
  // (a fork, then a circle) => 1 hollow circle, and 2 (source ticks) + 3 (target fork prongs) = 5
  // glyph <line>s in addition to the connector's own single <line>, so 6 <line>s total.
  await expect(edge.locator('circle')).toHaveCount(1);
  await expect(edge.locator('line')).toHaveCount(6);

  // No generic arrowhead marker at either end -- standard ERD notation has none.
  const connectorLine = edge.locator('line').first();
  await expect(connectorLine).not.toHaveAttribute('marker-end', /.+/);
  await expect(connectorLine).not.toHaveAttribute('marker-start', /.+/);
});

test('renders a dashed (non-identifying) many-to-many relationship with its own cardinality glyphs', async ({
  page,
}) => {
  await login(page);
  await importDsl(page, 'ERD Dashed Many-to-Many Rendering', ERD_DASHED_MANY_TO_MANY_DSL);

  const edge = page.locator('[data-testid="edge-e1"]');
  await expect(edge).toBeVisible();

  // '}|' and '|{' (reversed to '{|' from the PRODUCT end) are each fork+tick: no circles, and
  // (3 + 1) + (3 + 1) = 8 glyph <line>s plus the connector's own <line> = 9 total.
  await expect(edge.locator('circle')).toHaveCount(0);
  await expect(edge.locator('line')).toHaveCount(9);

  const connectorLine = edge.locator('line').first();
  await expect(connectorLine).not.toHaveAttribute('marker-end', /.+/);
  // The dashed (non-identifying) line style still applies alongside the glyphs.
  await expect(connectorLine).toHaveAttribute('stroke-dasharray', /.+/);
});

test('a plain flowchart edge (no cardinality) still renders exactly one arrowhead marker and no glyphs', async ({
  page,
}) => {
  await login(page);
  await importDsl(page, 'Plain Edge Regression Check', 'flowchart TD\n  A[Start] --> B[End]\n');

  const edge = page.locator('[data-testid="edge-e1"]');
  await expect(edge).toBeVisible();
  await expect(edge.locator('circle')).toHaveCount(0);
  await expect(edge.locator('line')).toHaveCount(1);

  const connectorLine = edge.locator('line').first();
  await expect(connectorLine).toHaveAttribute('marker-end', /.+/);
});
