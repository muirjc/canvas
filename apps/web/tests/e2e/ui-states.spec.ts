import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function openNewDiagram(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/**
 * User Story 4 (feature 005): no panel is ever a blank, unexplained region. Each of these forces
 * a real empty/loading/error condition rather than asserting on styling.
 */
test('an icon search with no matches explains itself', async ({ page }) => {
  await openNewDiagram(page);
  await page.getByTestId('palette-search').fill('zzzznotanicon');
  const empty = page.getByTestId('palette-no-results');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('zzzznotanicon');
});

test('a diagram with no violations says so explicitly', async ({ page }) => {
  await openNewDiagram(page);
  await page.getByTestId('rail-tab-issues').click();
  await expect(page.getByTestId('violations-panel-empty')).toContainText('No standards violations');
});

test('an empty version history explains itself rather than rendering blank', async ({ page }) => {
  // Creating a diagram always produces v1, so an empty history cannot occur naturally — the
  // response is stubbed to exercise the branch rather than pretending a fresh diagram has none.
  await page.route('**/diagrams/*/versions', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ versions: [] }) }),
  );
  await openNewDiagram(page);
  await page.getByTestId('rail-tab-history').click();
  await expect(page.getByTestId('version-history-empty')).toBeVisible();
});

test('a diagram never chatted with invites the first message', async ({ page }) => {
  await openNewDiagram(page);
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
  await page.getByTestId('rail-tab-chat').click();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await expect(page.locator('[data-testid^="chat-message-"]')).toHaveCount(0);
});

test('a failed load reports the failure and offers a retry', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();

  // Simulate the API being unreachable for the project tree specifically.
  await page.route('**/projects/*/tree', (route) => route.abort('failed'));
  await page.reload();

  const error = page.getByTestId('project-browser-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Could not load');
  await expect(error.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('motion is suppressed when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();

  // FR-023: the global guard reduces every duration to effectively zero.
  const duration = await page
    .getByTestId('new-diagram')
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(duration)).toBeLessThan(0.01);
});
