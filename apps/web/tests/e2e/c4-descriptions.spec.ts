import { expect, test } from '@playwright/test';

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
