import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-1u2: the C4 parser used to discard element descriptions/technology and Rel
 * technology/description, and the serializer wrote back only (alias, "label"). Because the DSL is
 * re-serialized on every canvas edit, the first edit + save of an imported C4 diagram silently
 * deleted them. This proves the real flow: import -> edit on canvas -> save -> reload.
 */
const DSL = [
  'C4Container',
  '    Person(customer, "Customer", "A bank customer")',
  '    Container(api, "API", "Java, Spring", "Handles requests")',
  '    ContainerDb(db, "Database", "PostgreSQL", "Stores accounts")',
  '    Rel(customer, api, "Uses", "HTTPS", "Reads balances")',
  '    Rel(api, db, "Reads from", "JDBC")',
  '',
].join('\n');

const EXPECTED_LINES = [
  'Person(customer, "Customer", "A bank customer")',
  'Container(api, "API", "Java, Spring", "Handles requests")',
  'ContainerDb(db, "Database", "PostgreSQL", "Stores accounts")',
  'Rel(customer, api, "Uses", "HTTPS", "Reads balances")',
  'Rel(api, db, "Reads from", "JDBC")',
];

test('C4 descriptions and technology survive a canvas edit, save and reload', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();

  const name = `C4 Descriptions ${Date.now()}`;
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(DSL);
  await page.getByTestId('confirm-import').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  const dslPanel = page.getByTestId('dsl-panel');
  await expect(page.getByTestId('node-api')).toBeVisible();
  for (const line of EXPECTED_LINES) await expect(dslPanel).toContainText(line);

  // A canvas edit that forces re-serialization: drag node-api.
  const before = await dslPanel.inputValue();
  const box = (await page.getByTestId('node-api').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 60, { steps: 8 });
  await page.mouse.up();

  // The drag really re-serialized the DSL (positions front-matter changed)...
  await expect.poll(async () => dslPanel.inputValue()).not.toBe(before);
  // ...and the descriptions/technology are still there right after it.
  for (const line of EXPECTED_LINES) await expect.poll(async () => dslPanel.inputValue()).toContain(line);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  // Reload and reopen the saved diagram.
  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page
    .locator('li.row', { hasText: name })
    .locator('[data-testid^="open-diagram-"]')
    .click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('node-api')).toBeVisible();

  for (const line of EXPECTED_LINES) {
    await expect.poll(async () => page.getByTestId('dsl-panel').inputValue()).toContain(line);
  }
});

/**
 * canvas-8th: described C4 elements and relationship technology are now DRAWN (canvas + export)
 * from one shared layout; person text sits below the head.
 */
const DRAWN_DSL = [
  'C4Container',
  '    Person(customer, "Customer", "A bank customer")',
  '    Person(clerk, "Clerk")',
  '    Container(api, "API", "Java, Spring", "Handles requests")',
  '    System(plain, "Plain System")',
  '    Rel(customer, api, "Uses", "HTTPS")',
  '',
].join('\n');

async function importDrawn(page: Page): Promise<string> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);

  const name = `C4 Drawn ${Date.now()}`;
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(DRAWN_DSL);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('node-api')).toBeVisible();
  return name;
}

test('C4 technology and description are drawn on the canvas', async ({ page }) => {
  await importDrawn(page);

  const api = page.getByTestId('node-api');
  await expect(api.locator('text').first()).toHaveText('API');
  await expect(api.locator('text').first()).toHaveAttribute('font-weight', 'bold');
  const apiDetails = page.getByTestId('node-detail-api');
  await expect(apiDetails).toHaveCount(2);
  await expect(apiDetails.nth(0)).toHaveText('[Java, Spring]');
  await expect(apiDetails.nth(1)).toHaveText('Handles requests');

  const customer = page.getByTestId('node-customer');
  await expect(customer.locator('text', { hasText: 'A bank customer' })).toHaveCount(1);
  await expect(customer.locator('text', { hasText: '[' })).toHaveCount(0);

  await expect(page.getByTestId('node-detail-plain')).toHaveCount(0);

  const tech = page.locator('[data-testid^="edge-technology-"]');
  await expect(tech).toHaveCount(1);
  await expect(tech).toHaveText('[HTTPS]');
});

test('C4 person text starts below the head', async ({ page }) => {
  await importDrawn(page);

  for (const id of ['customer', 'clerk']) {
    const node = page.getByTestId(`node-${id}`);
    await expect(node.locator('circle')).toHaveCount(1);
    const head = (await node.locator('circle').boundingBox())!;
    const text = (await node.locator('text').first().boundingBox())!;
    expect(text.y, `${id}: name starts below head`).toBeGreaterThanOrEqual(head.y + head.height);
  }
});

test('C4 SVG export includes technology and description', async ({ page }) => {
  const name = await importDrawn(page);
  expect(name).toBeTruthy();

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  await page.getByTestId('export-menu-trigger').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-svg').click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = readFileSync(path!, 'utf-8');
  expect(svg).toContain('[Java, Spring]');
  expect(svg).toContain('Handles requests');
  expect(svg).toContain('[HTTPS]');
});
