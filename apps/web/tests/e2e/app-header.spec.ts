import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-t3b.4 (docs/browse-screen-design.md §4, §7): the header names its sections (Projects,
 * and Admin for admins) instead of carrying a project picker, and the admin console's back link
 * returns to wherever the user was browsing.
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

test('the admin back link returns to the project you were browsing', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();

  await page.getByTestId('nav-admin').click();
  await expect(page.getByTestId('admin-shell')).toBeVisible();
  await page.getByTestId('admin-back-to-diagrams').click();

  await expect(page.getByTestId('project-browser')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('projectId')).toBe(PROJECT_ID);
});

test('the admin back link returns to the project list when you came from the list', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/');
  await expect(page.getByTestId('projects-page-list')).toBeVisible();

  await page.getByTestId('nav-admin').click();
  await expect(page.getByTestId('admin-shell')).toBeVisible();
  await page.getByTestId('admin-back-to-diagrams').click();

  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('projectId')).toBeNull();
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
