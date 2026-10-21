import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-228.2. Covers soft-deleting an empty project from the Projects screen
 * (`ProjectsPage.tsx`) and its admin recovery (`DeletedProjectsPage.tsx`): the disabled/enabled
 * Delete button rule (only a diagram-free project may be deleted), the confirm-dialog flow
 * (reusing the same `ConfirmDialog` diagram-delete already uses), the current-project fallback
 * when the deleted project was the active one, and the admin-only restore path. Backend contract
 * coverage already exists (`apps/api/tests/contract/project-delete-restore.test.ts`) — this only
 * exercises the UI wiring.
 */

async function signIn(page: Page, email: string, password: string, url = '/'): Promise<void> {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/** Creates a project owned by whoever `page` is signed in as. */
async function createProject(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects`, { data: { name } });
  expect(response.status()).toBe(201);
  return (await response.json()).project.id;
}

async function createDiagram(page: Page, projectId: string, name: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name, diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).diagram.id;
}

test('Delete is disabled with an explanatory title for a project with a diagram, and enabled for an empty one', async ({
  page,
}) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const emptyName = `Delete Gate Empty ${Date.now()}`;
  const nonEmptyName = `Delete Gate NonEmpty ${Date.now()}`;
  const emptyId = await createProject(page, emptyName);
  const nonEmptyId = await createProject(page, nonEmptyName);
  await createDiagram(page, nonEmptyId, 'Blocks Deletion');

  await page.goto(`/?projectId=${emptyId}`);
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('nav-projects').click();

  const emptyDelete = page.getByTestId(`projects-page-delete-${emptyId}`);
  await expect(emptyDelete).toBeVisible();
  await expect(emptyDelete).toBeEnabled();
  await expect(emptyDelete).not.toHaveAttribute('title', /.+/);

  const nonEmptyDelete = page.getByTestId(`projects-page-delete-${nonEmptyId}`);
  await expect(nonEmptyDelete).toBeVisible();
  await expect(nonEmptyDelete).toBeDisabled();
  await expect(nonEmptyDelete).toHaveAttribute('title', 'Only a project with no diagrams can be deleted.');
});

test('deleting an empty project via the confirm dialog removes it from the Projects screen list', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  const name = `Delete Confirm ${Date.now()}`;
  const projectId = await createProject(page, name);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('nav-projects').click();

  const row = page.getByTestId(`projects-page-row-${projectId}`);
  await expect(row).toBeVisible();

  await page.getByTestId(`projects-page-delete-${projectId}`).click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await expect(page.getByTestId('confirm-dialog')).toContainText(
    `Delete "${name}"? It can be recovered by an admin for a limited time.`,
  );
  await page.getByTestId('confirm-dialog-confirm').click();

  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(row).toHaveCount(0);
});

test('cancelling the delete confirmation leaves the project in place', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  const name = `Delete Cancel ${Date.now()}`;
  const projectId = await createProject(page, name);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('nav-projects').click();

  const row = page.getByTestId(`projects-page-row-${projectId}`);
  await expect(row).toBeVisible();

  await page.getByTestId(`projects-page-delete-${projectId}`).click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-dialog-cancel').click();

  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(row).toBeVisible();
});

test('deleting a project the user last opened keeps them on the Projects list without an error', async ({
  page,
}) => {
  // canvas-t3b.2: there is no "current project" to fall back from any more. Deleting happens on the
  // Projects list, the user stays there, and a deleted last-opened hint is cleared.
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const activeId = await createProject(page, `Delete Active ${Date.now()}`);

  // Opening the project by address records it as the last-opened landing hint.
  await page.goto(`/?projectId=${activeId}`);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('canvas.lastProjectId'))).toBe(activeId);

  await page.getByTestId('nav-projects').click();
  await page.getByTestId(`projects-page-delete-${activeId}`).click();
  await page.getByTestId('confirm-dialog-confirm').click();

  await expect(page.getByTestId(`projects-page-row-${activeId}`)).toHaveCount(0);
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  await expect(page.getByTestId('projects-page-delete-error')).toHaveCount(0);
  // Still on the Projects list, and the hint no longer points at the deleted project.
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await expect(page.getByTestId('new-diagram')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('canvas.lastProjectId'))).toBeNull();
});

test('an admin sees a deleted project on the Deleted Projects screen and restoring it brings it back to the Projects screen', async ({
  page,
}) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  const name = `Delete Restore ${Date.now()}`;
  const projectId = await createProject(page, name);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('nav-projects').click();
  await page.getByTestId(`projects-page-delete-${projectId}`).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId(`projects-page-row-${projectId}`)).toHaveCount(0);

  await page.goto('/?admin=deleted-projects');
  await expect(page.getByTestId('admin-shell')).toBeVisible();
  const deletedRow = page.getByTestId(`deleted-project-row-${projectId}`);
  await expect(deletedRow).toBeVisible();
  await expect(deletedRow).toContainText(name);

  await page.getByTestId(`restore-project-${projectId}`).click();
  await expect(page.getByTestId('deleted-projects-message')).toContainText('restored');
  await expect(deletedRow).toHaveCount(0);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId(`projects-page-row-${projectId}`)).toBeVisible();
});

test('a non-admin cannot reach the Deleted Projects admin screen', async ({ page }) => {
  await signIn(page, ARCHITECT_EMAIL, ARCHITECT_PASSWORD, `/?projectId=${PROJECT_ID}`);

  await page.goto(`/?projectId=${PROJECT_ID}&admin=deleted-projects`);
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
});
