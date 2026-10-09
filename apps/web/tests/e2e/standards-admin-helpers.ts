import { expect, type Page } from '@playwright/test';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'admin-dev-password';

/** Sign in as the seeded admin and land on the Standards admin page (flowchart pre-selected). */
export async function openStandardsAdmin(page: Page, url = '/?admin=standards') {
  await page.goto(url);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('standard-new')).toBeVisible();
}

/** Open the (collapsed) legacy v1 rules section of the standards editor. */
export async function openLegacyRules(page: Page) {
  const details = page.getByTestId('legacy-rules');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}

/** Publish the editor's current draft through the confirm dialog. */
export async function publishFromEditor(page: Page) {
  await page.getByTestId('standard-publish').click();
  await page.getByTestId('standard-publish-confirm-button').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText('Published standard');
}

/** New flowchart standard using only the v1 shape rules, created and published in one go. */
export async function createAndPublishShapeStandard(
  page: Page,
  opts: { name: string; description?: string; allowed?: string[]; mandatory?: string[] },
) {
  await page.getByTestId('standard-new').click();
  await page.getByTestId('standard-name-input').fill(opts.name);
  if (opts.description) await page.getByTestId('standard-description-input').fill(opts.description);
  await openLegacyRules(page);
  for (const shape of opts.allowed ?? []) await page.getByTestId(`allowed-shape-${shape}`).locator('input').check();
  for (const shape of opts.mandatory ?? []) await page.getByTestId(`mandatory-shape-${shape}`).locator('input').check();
  await publishFromEditor(page);
}
