import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-fkp: in-app Help -- the user and admin guides rendered from docs/, with search, and "?"
 * links from screens to the matching section.
 */
async function signIn(page: Page, email = 'admin@example.com', password = 'admin-dev-password') {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
}

test('Help in the header opens the guide; pages, sections and Back work', async ({ page }) => {
  await signIn(page);
  await page.getByTestId('nav-help').click();
  await expect(page).toHaveURL(/\?help=user$/);
  await expect(page.getByTestId('help-title')).toHaveText('Canvas user guide');
  await expect(page.getByTestId('help-title')).toBeFocused();
  await expect(page).toHaveTitle('Canvas user guide – Help – Canvas');
  await expect(page.getByTestId('nav-help')).toHaveAttribute('aria-current', 'page');

  // A link inside a page goes to another page, in the app.
  await page.getByTestId('help-page-user').getByRole('link', { name: 'The editor' }).click();
  await expect(page).toHaveURL(/\?help=user\/editor$/);
  await expect(page.getByTestId('help-title')).toHaveText('The editor');
  await expect(page.getByTestId('help-page-user-editor').locator('img').first()).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId('help-title')).toHaveText('Canvas user guide');

  // The admin guide is listed for admins.
  await page.getByTestId('help-nav-admin-people').click();
  await expect(page.getByTestId('help-title')).toHaveText('Managing people');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
});

test('search finds a section and opens it', async ({ page }) => {
  await signIn(page);
  await page.goto('/?help=user');
  await page.getByTestId('help-search').fill('zoom fit');
  await expect(page.getByTestId('help-hit-0')).toHaveText('The editor: Zoom');
  await page.getByTestId('help-hit-0').click();
  await expect(page).toHaveURL(/\?help=user\/editor&section=zoom$/);
  await expect(page.locator('#zoom')).toBeInViewport();

  await page.getByTestId('help-search').fill('qwertyuiop');
  await expect(page.getByTestId('help-search-empty')).toBeVisible();
});

test('the admin guide is admins only', async ({ page }) => {
  await signIn(page, 'architect@example.com', 'architect-dev-password');
  await page.goto('/?help=user');
  await expect(page.getByTestId('help-nav-user-common-questions')).toBeVisible();
  await expect(page.getByTestId('help-nav-admin-people')).toHaveCount(0);
  // An admin page's address shows the user guide instead.
  await page.goto('/?help=admin/people');
  await expect(page.getByTestId('help-title')).toHaveText('Canvas user guide');
});

test('"?" links open the matching section in a new tab', async ({ page, context }) => {
  await signIn(page);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('rail-tab-issues').click();
  const link = page.getByTestId('help-link-user-editor-the-issues-tab-standards');
  await expect(link).toHaveAttribute('target', '_blank');
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await expect(tab).toHaveURL(/\?help=user\/editor&section=the-issues-tab-standards$/);
  await expect(tab.locator('#the-issues-tab-standards')).toBeInViewport();
  // The editor stayed where it was.
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
});
