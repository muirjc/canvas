import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run the demo seed (python -m canvas_api.jobs.seed_demo) and export it first');

/**
 * canvas-4e0: admin pages are part of the app's location model -- the header's Admin link, the admin
 * navigation and the links inside admin pages move in-app (history entry, focus on the page's h1, tab
 * title, unsaved-changes guard) instead of loading the page again.
 */

async function signIn(page: Page, email: string, password: string, url = '/') {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/** A full page load would reset this; an in-app navigation keeps it. */
async function markPage(page: Page) {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}
async function pageWasNotReloaded(page: Page) {
  return page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true);
}

function search(page: Page) {
  return new URL(page.url()).search;
}

test('the header Admin link and the admin navigation move in-app, following address, title, current page and focus', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await markPage(page);

  await page.getByTestId('nav-admin').click();
  await expect(page.getByTestId('admin-shell')).toBeVisible();
  expect(search(page)).toBe('?admin=overview');
  await expect(page).toHaveTitle('Overview – Admin – Canvas');
  await expect(page.getByTestId('admin-nav-overview')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1, name: 'Admin Overview' })).toBeFocused();

  await page.getByTestId('admin-nav-users').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeFocused();
  expect(search(page)).toBe('?admin=users');
  await expect(page).toHaveTitle('Users – Admin – Canvas');
  await expect(page.getByTestId('admin-nav-users')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('admin-nav-overview')).not.toHaveAttribute('aria-current', 'page');

  await page.getByTestId('admin-nav-audit').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeFocused();
  expect(search(page)).toBe('?admin=audit');
  await expect(page).toHaveTitle('Audit log – Admin – Canvas');
  await expect(page.getByTestId('admin-nav-audit')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('admin-nav-users')).not.toHaveAttribute('aria-current', 'page');

  expect(await pageWasNotReloaded(page)).toBe(true);
});

test('Back and Forward walk the admin pages and back to Browse', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await markPage(page);

  await page.getByTestId('nav-admin').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Admin Overview' })).toBeVisible();
  await page.getByTestId('admin-nav-users').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await page.getByTestId('admin-nav-audit').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  expect(search(page)).toBe('?admin=users');
  await expect(page.getByTestId('admin-nav-users')).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Admin Overview' })).toBeVisible();
  expect(search(page)).toBe('?admin=overview');
  await page.goBack();
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);

  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Admin Overview' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();

  expect(await pageWasNotReloaded(page)).toBe(true);
});

test('View activity filters the audit log to one user and Show all activity clears it, both in-app', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=users');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await markPage(page);

  const viewActivity = page.locator('[data-testid^="view-activity-"]').first();
  await expect(viewActivity).toBeVisible();
  const testId = (await viewActivity.getAttribute('data-testid')) ?? '';
  const userId = testId.replace('view-activity-', '');
  await viewActivity.click();

  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeFocused();
  expect(search(page)).toBe(`?admin=audit&userId=${userId}`);
  await expect(page.getByText('Showing activity for one user.')).toBeVisible();
  await expect(page).toHaveTitle('Audit log – Admin – Canvas');
  await expect(page.getByTestId('admin-nav-audit')).toHaveAttribute('aria-current', 'page');

  // The unfiltered list can only hold the same events or more, so what appears under "Show all" is
  // proof the list reloaded rather than keeping the filtered one.
  const rows = page.locator('[data-testid^="audit-row-"]');
  await expect(rows.first().or(page.getByTestId('audit-empty'))).toBeVisible();
  const filteredCount = await rows.count();

  await page.getByRole('link', { name: 'Show all activity' }).click();
  await expect(page.getByText('Showing activity for one user.')).toHaveCount(0);
  expect(search(page)).toBe('?admin=audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeFocused();
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(filteredCount);
  await expect(rows.first()).toBeVisible();

  // Back returns to the filtered log.
  await page.goBack();
  await expect(page.getByText('Showing activity for one user.')).toBeVisible();
  expect(search(page)).toBe(`?admin=audit&userId=${userId}`);

  expect(await pageWasNotReloaded(page)).toBe(true);
});

test('the header Admin link from an editor with unsaved changes asks in-app, not with the browser prompt', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  await markPage(page);

  // A beforeunload prompt would arrive as a dialog event; none should.
  const browserDialogs: string[] = [];
  page.on('dialog', (dialog) => {
    browserDialogs.push(dialog.type());
    void dialog.dismiss();
  });

  await page.getByTestId('nav-admin').click();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);

  await page.getByTestId('cancel-home-nav').click();
  await expect(page.getByTestId('home-nav-confirm')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  expect(search(page)).toContain('diagramId=');

  await page.getByTestId('nav-admin').click();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();
  await page.getByTestId('confirm-home-nav').click();
  await expect(page.getByTestId('admin-shell')).toBeVisible();
  expect(search(page)).toBe('?admin=overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Admin Overview' })).toBeVisible();

  expect(browserDialogs).toEqual([]);
  expect(await pageWasNotReloaded(page)).toBe(true);
});

test('a non-admin opening an admin address ends up on the project list with no admin address', async ({ page }) => {
  await signIn(page, ARCHITECT_EMAIL, ARCHITECT_PASSWORD, '/?admin=users');
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);
  await expect(page.getByTestId('nav-admin')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('admin')).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('a non-admin opening an admin address inside a project stays on that project, without the admin parameter', async ({ page }) => {
  await signIn(page, ARCHITECT_EMAIL, ARCHITECT_PASSWORD, `/?projectId=${PROJECT_ID}&admin=users`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has('admin')).toBe(false);
  expect(new URL(page.url()).searchParams.get('projectId')).toBe(PROJECT_ID);
});
