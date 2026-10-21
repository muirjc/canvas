import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-t3b.4 (docs/browse-screen-design.md §4, §7): the header names its sections (Projects,
 * and Admin for admins) instead of carrying a project picker, and the header's Projects link leaves
 * the admin console (canvas-513).
 */

async function signIn(page: Page, email: string, password: string, url = '/') {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

async function openNewDiagram(page: Page) {
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('Projects is the current section on the project list and on a project, but not in the editor', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/');
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await expect(page.getByTestId('nav-projects')).toHaveAttribute('aria-current', 'page');

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await expect(page.getByTestId('nav-projects')).toHaveAttribute('aria-current', 'page');

  await openNewDiagram(page);
  await expect(page.getByTestId('nav-projects')).toBeVisible();
  await expect(page.getByTestId('nav-projects')).not.toHaveAttribute('aria-current', 'page');
});

test('the Admin link exists for admins only and opens the admin overview as the current section', async ({ browser }) => {
  const architectContext = await browser.newContext();
  const architectPage = await architectContext.newPage();
  await signIn(architectPage, ARCHITECT_EMAIL, ARCHITECT_PASSWORD);
  await expect(architectPage.getByTestId('nav-projects')).toBeVisible();
  await expect(architectPage.getByTestId('nav-admin')).toHaveCount(0);
  await architectContext.close();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  await adminPage.getByTestId('nav-admin').click();
  await expect(adminPage).toHaveURL(/admin=overview/);
  await expect(adminPage.getByTestId('admin-shell')).toBeVisible();
  await expect(adminPage.getByTestId('nav-admin')).toHaveAttribute('aria-current', 'page');
  await expect(adminPage.getByTestId('nav-projects')).not.toHaveAttribute('aria-current', 'page');
  await adminContext.close();
});

test('the first Tab stop is the skip link, and activating it moves focus to the main content', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  // Reset focus to the start of the document, as after a fresh page load.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await page.keyboard.press('Tab');
  await expect(page.getByTestId('skip-to-main')).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('the retired header controls are gone', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await expect(page.getByTestId('project-picker')).toHaveCount(0);
  await expect(page.getByTestId('view-projects')).toHaveCount(0);
});

// canvas-513: replaces the admin Back link tests -- the header's Projects link now leaves admin.
const ADMIN_PAGES = [
  { param: 'overview', h1: 'Admin Overview', title: 'Overview – Admin – Canvas' },
  { param: 'standards', h1: 'Standards', title: 'Standards – Admin – Canvas' },
  { param: 'users', h1: 'Users', title: 'Users – Admin – Canvas' },
  { param: 'deleted', h1: 'Deleted Diagrams', title: 'Deleted Diagrams – Admin – Canvas' },
  { param: 'deleted-projects', h1: 'Deleted Projects', title: 'Deleted Projects – Admin – Canvas' },
  { param: 'ai-personas', h1: 'AI Personas', title: 'AI Personas – Admin – Canvas' },
  { param: 'true', h1: 'Standards', title: 'Standards – Admin – Canvas' },
];

for (const param of ['overview', 'users']) {
  test(`Projects from ?admin=${param} opens the project list in-app; Back and Forward walk the history`, async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?admin=${param}`);
    await expect(page.getByTestId('admin-shell')).toBeVisible();
    await expect(page.getByTestId('admin-back-to-diagrams')).toHaveCount(0);
    // A full reload would reset this marker; an in-app navigation keeps it.
    await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));

    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('projects-page-list')).toBeVisible();
    await expect(page.getByTestId('admin-shell')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(new URL(page.url()).search).toBe('');
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`admin=${param}`));
    await expect(page.getByTestId('admin-shell')).toBeVisible();
    await expect(page.getByTestId('projects-page-list')).toHaveCount(0);

    await page.goForward();
    await expect(page.getByTestId('projects-page-list')).toBeVisible();
    await expect(page.getByTestId('admin-shell')).toHaveCount(0);
  });
}

test('every admin page has exactly one h1 and names itself in the tab title', async ({ page }) => {
  // canvas-4pw
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=overview');
  for (const { param, h1, title } of ADMIN_PAGES) {
    await page.goto(`/?admin=${param}`);
    await expect(page.getByTestId('admin-shell')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }), `h1 on ?admin=${param}`).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(h1);
    await expect(page, `title on ?admin=${param}`).toHaveTitle(title);
  }
});

test('Projects from an editor with unsaved changes asks before leaving', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  await openNewDiagram(page);
  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();
  await page.getByTestId('cancel-home-nav').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
});
