import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/** Creates a diagram and saves it enough times to exceed the five-version display cap. */
async function diagramWithManyVersions(page: Page, saves: number) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  for (let i = 0; i < saves; i += 1) {
    await page.getByTestId('add-shape-rectangle').click();
    await page.getByTestId('save-diagram').click();
    await expect(page.getByTestId('save-status')).toHaveText('saved');
  }
  await page.getByTestId('rail-tab-history').click();
}

/**
 * User Story 5 (feature 006): version history is bounded and searchable.
 *
 * Previously every version was listed, so a diagram saved a hundred times produced a hundred
 * rows — and an unbounded response to match.
 */
test('shows only the five most recent versions and says older ones exist', async ({ page }) => {
  await diagramWithManyVersions(page, 7);

  // FR-028.
  // Exact pattern: a prefix match would also catch version-history / version-search.
  await expect(page.getByTestId(/^version-\d+$/)).toHaveCount(5);
  // FR-029: their existence is evident.
  await expect(page.getByTestId('version-history-more')).toBeVisible();
});

test('finds an older version by search and restores it', async ({ page }) => {
  await diagramWithManyVersions(page, 7);

  // Version 2 is well outside the default window.
  await expect(page.getByTestId('version-2')).toHaveCount(0);

  await page.getByTestId('version-search').fill('2');
  const older = page.getByTestId('version-2');
  await expect(older).toBeVisible();

  // FR-031: restorable exactly as a recent version is.
  await page.getByTestId('restore-version-2').click();
  await expect(page.getByTestId('version-history')).toBeVisible();
});

test('an unmatched search says so rather than showing a blank area', async ({ page }) => {
  await diagramWithManyVersions(page, 2);

  await page.getByTestId('version-search').fill('99999');
  // FR-032.
  await expect(page.getByTestId('version-search-empty')).toBeVisible();
});

test('a history at exactly the cap does not imply hidden versions', async ({ page }) => {
  // Creating the diagram makes v1, so four saves gives exactly five versions — the boundary the
  // spec calls out.
  await diagramWithManyVersions(page, 4);

  await expect(page.getByTestId(/^version-\d+$/)).toHaveCount(5);
  await expect(page.getByTestId('version-history-more')).toHaveCount(0);
});
