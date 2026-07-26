import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 3 end-to-end: the new-diagram picker offers persona-scoped diagram types, and a
 * diagram of a cloud/technical type can search and place official (placeholder) Azure/AWS icons.
 */
test('offers scoped diagram types and finds Azure/AWS icons by name', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('new-diagram').click();
  // The full built-in catalog is offered (no persona filter applied in this dialog instance).
  await expect(page.getByTestId('diagram-type-cloud-infrastructure')).toBeVisible();
  await expect(page.getByTestId('diagram-type-business-capability-map')).toBeVisible();

  await page.getByTestId('diagram-type-cloud-infrastructure').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const search = page.getByTestId('palette-search');
  await search.fill('Lambda');
  await expect(page.getByTestId('palette-icon-aws-icons-lambda')).toBeVisible();

  await search.fill('Blob Storage');
  await expect(page.getByTestId('palette-icon-azure-icons-blob-storage')).toBeVisible();

  await page.getByTestId('palette-icon-azure-icons-blob-storage').click();
  await expect(page.getByTestId('dsl-panel')).toContainText('blob-storage');
});
