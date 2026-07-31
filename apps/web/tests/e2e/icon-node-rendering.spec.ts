import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function login(page: import('@playwright/test').Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

/**
 * canvas-8n7: an icon-shaped node placed from the palette must show its real icon artwork on the
 * canvas, not just label text in a generic box — matching what export already draws once its own
 * resolveIcon wiring (also fixed by this bead) is in place. Uses the bundled AWS-icons placeholder
 * library (aws-icons.ts): Lambda's distinctive fill is #ec7211 (placeholder-icon.ts), a simple,
 * stable marker that the real icon markup rendered rather than a plain box.
 */
test('places an icon node from the palette and shows its real artwork, not just label text', async ({ page }) => {
  await login(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-cloud-infrastructure').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('palette-search').fill('Lambda');
  await page.getByTestId('palette-icon-aws-icons-lambda').click();

  const iconArtwork = page.locator('[data-testid^="node-"] [fill="#ec7211"]');
  await expect(iconArtwork).toHaveCount(1);
});

test('preserves the icon node\'s shape and artwork through save and reload', async ({ page }) => {
  await login(page);
  const diagramName = `Icon Node Round Trip ${Date.now()}`;
  // Matches serializeFlowchart's real output for a shape:'icon' node carrying an aws-icons/lambda
  // ref — imported rather than placed via the palette so the diagram has a findable name
  // (the "new diagram" flow has no name field; only import does).
  const iconNodeDsl = [
    '---',
    'canvas:',
    '  positions:',
    '    A:',
    '      x: 10',
    '      y: 10',
    '  icons:',
    '    A:',
    '      libraryId: aws-icons',
    '      libraryVersion: "2024.1"',
    '      iconId: lambda',
    '---',
    'flowchart TD',
    '  A[Lambda]',
    '',
  ].join('\n');

  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(diagramName);
  await page.getByTestId('import-textarea').fill(iconNodeDsl);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const iconArtworkBeforeSave = page.locator('[data-testid^="node-"] [fill="#ec7211"]');
  await expect(iconArtworkBeforeSave).toHaveCount(1);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  const row = page.locator('li.row', { hasText: diagramName });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // Confirms the parser's shape-inference fix too: without it, shape reverts to 'rectangle' on
  // reparse (icon and rectangle share identical `[label]` bracket delimiters) and this artwork
  // would disappear after reload even though it showed correctly before saving.
  const iconArtwork = page.locator('[data-testid^="node-"] [fill="#ec7211"]');
  await expect(iconArtwork).toHaveCount(1);
});

test('exports the icon node with the same real artwork', async ({ page }) => {
  await login(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-cloud-infrastructure').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('palette-search').fill('Lambda');
  await page.getByTestId('palette-icon-aws-icons-lambda').click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');

  expect(svg).toContain('#ec7211');
});

/**
 * canvas-8n7 also fixed cylinder falling through to a plain rectangle on the canvas only (export
 * already drew it correctly) — a smaller, explicitly-requested part of the same bug.
 */
test('renders a cylinder node as a cylinder on the canvas, not a plain rectangle', async ({ page }) => {
  await login(page);

  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill('Cylinder Canvas');
  await page.getByTestId('import-textarea').fill('flowchart TD\n  A[(Database)]\n');
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await expect(page.locator('[data-testid="node-A"] path')).toHaveCount(1);
  await expect(page.locator('[data-testid="node-A"] ellipse')).toHaveCount(1);
  await expect(page.locator('[data-testid="node-A"] rect')).toHaveCount(0);
});
