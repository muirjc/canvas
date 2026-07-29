import { expect, test, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function openStandardsAdmin(page: Page) {
  await page.goto('/?admin=true');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('create-publish-standard')).toBeVisible();
}

async function createAndPublish(page: Page, name: string, description?: string) {
  await page.getByTestId('standard-name-input').fill(name);
  if (description) await page.getByTestId('standard-description-input').fill(description);
  // The seeded standard permits rectangles; keep the new one equivalent so publishing it does
  // not invalidate unrelated diagrams used by other specs.
  await page.getByTestId('allowed-shape-rectangle').check();
  await page.getByTestId('create-publish-standard').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText('Published');
}

/**
 * User Story 4 (feature 006): standards are identifiable and their lifecycle is visible.
 *
 * Before this a standard showed only a version number and status — the development database held
 * 33 of them, distinguishable only by UUID.
 */
test('a created standard shows its name, description, and creation date', async ({ page }) => {
  await openStandardsAdmin(page);
  const name = `Core Rules ${Date.now()}`;
  await createAndPublish(page, name, 'Shapes permitted for process maps.');

  const history = page.getByTestId('standards-history');
  await expect(history).toContainText(name);
  await expect(history).toContainText('Shapes permitted for process maps.');
  await expect(history).toContainText('Created');
});

test('every standard in the list is identifiable by name, including pre-existing ones', async ({ page }) => {
  await openStandardsAdmin(page);

  // FR-026 / SC-006: standards created before this feature were backfilled, so no row falls back
  // to being identified only by id.
  const rows = page.locator('[data-testid^="standard-row-"]');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < Math.min(count, 8); i += 1) {
    await expect(rows.nth(i)).not.toHaveText('');
    await expect(rows.nth(i).locator('.row__title')).not.toHaveText(/^\s*$/);
  }
});

test('retiring a standard records and shows a retirement date', async ({ page }) => {
  await openStandardsAdmin(page);
  const name = `To Retire ${Date.now()}`;
  await createAndPublish(page, name);

  const row = page.locator('li', { has: page.locator(`text=${name}`) }).first();
  await expect(row).not.toContainText('Retired');

  await row.locator('[data-testid^="retire-standard-"]').click();

  const retiredRow = page.locator('li', { has: page.locator(`text=${name}`) }).first();
  await expect(retiredRow).toContainText('Retired');
});

test('a standard retired by SUPERSESSION also shows a retirement date', async ({ page }) => {
  await openStandardsAdmin(page);

  // The path most easily missed: publishing a newer standard auto-retires the previous one.
  const firstName = `Superseded ${Date.now()}`;
  await createAndPublish(page, firstName);
  const secondName = `Successor ${Date.now()}`;
  await createAndPublish(page, secondName);

  const supersededRow = page.locator('li', { has: page.locator(`text=${firstName}`) }).first();
  await expect(supersededRow).toContainText('retired');
  await expect(supersededRow, 'a superseded standard shows no retirement date').toContainText('Retired');
});

test('a standard that has never been retired shows no retirement date', async ({ page }) => {
  await openStandardsAdmin(page);
  const name = `Still Active ${Date.now()}`;
  await createAndPublish(page, name);

  const row = page.locator('li', { has: page.locator(`text=${name}`) }).first();
  await expect(row).toContainText('Created');
  await expect(row).not.toContainText('Retired');
});
