import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-228.1. Covers the new Projects screen: reaching it, the list (with per-project diagram
 * counts), creating a project from it, cancelling that form, the unsaved-changes navigation guard
 * (mirrors `editor-back-navigation.spec.ts`'s `requestGoHome` pattern exactly, since
 * `requestViewProjects` is the same guard landing somewhere else), and the Back button.
 */

async function signIn(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
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

async function openNewDiagram(page: Page): Promise<void> {
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('the Projects button is visible once signed in and lists the current project with its diagram count', async ({
  page,
}) => {
  // Project creation requires auth, so sign in first, then create the fixture and reload scoped
  // to it — the counts App fetches at login are then correct from the start, no client-side
  // refetch needed.
  await signIn(page);
  const projectName = `Projects Page List ${Date.now()}`;
  const projectId = await createProject(page, projectName);
  await createDiagram(page, projectId, 'Only Diagram');

  await page.goto(`/?projectId=${projectId}`);
  await expect(page.getByTestId('sign-out')).toBeVisible();

  await expect(page.getByTestId('view-projects')).toBeVisible();
  await page.getByTestId('view-projects').click();

  const row = page.getByTestId(`projects-page-row-${projectId}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(projectName);
  await expect(page.getByTestId(`projects-page-diagram-count-${projectId}`)).toHaveText('1 diagram');

  // The seeded project (many diagrams accumulated across prior runs) is also listed, with a
  // plausible diagram count — not asserting an exact number, per the seeded DB's own caveat.
  const seededRow = page.getByTestId(`projects-page-row-${PROJECT_ID}`);
  await expect(seededRow).toBeVisible();
  await expect(page.getByTestId(`projects-page-diagram-count-${PROJECT_ID}`)).toHaveText(/^\d+ diagrams?$/);
});

test('a brand-new project with zero diagrams is listed as "0 diagrams"', async ({ page }) => {
  await signIn(page);
  const projectName = `Projects Page Zero ${Date.now()}`;
  const projectId = await createProject(page, projectName);

  await page.goto(`/?projectId=${projectId}`);
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('view-projects').click();

  await expect(page.getByTestId(`projects-page-diagram-count-${projectId}`)).toHaveText('0 diagrams');
});

test('creating a project from the Projects screen makes it the active project and adds it to the picker', async ({
  page,
}) => {
  await signIn(page, `/?projectId=${PROJECT_ID}`);

  await page.getByTestId('view-projects').click();
  await expect(page.getByTestId('projects-page-start-create')).toBeVisible();
  await page.getByTestId('projects-page-start-create').click();

  const newName = `Projects Page Created ${Date.now()}`;
  await page.getByTestId('projects-page-new-name').fill(newName);
  await page.getByTestId('projects-page-confirm-create').click();

  // Creation navigates away from the Projects screen back to the (now newly-scoped) home screen.
  await expect(page.getByTestId('projects-page-list')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();

  // The new project is now the active project...
  await expect(page.getByTestId('project-name')).toHaveText(newName);
  // ...and is selectable from the picker without a reload (mirrors createFirstProject's own
  // local-state update, and the assertion style project-visibility.spec.ts uses for its own
  // `project-picker-option` checks).
  await expect(page.getByTestId('project-picker-option').filter({ hasText: newName })).toHaveCount(1);
});

test('cancelling the create form discards the in-progress name without creating anything', async ({ page }) => {
  await signIn(page, `/?projectId=${PROJECT_ID}`);
  await page.getByTestId('view-projects').click();
  await page.getByTestId('projects-page-start-create').click();

  const abandonedName = `Projects Page Abandoned ${Date.now()}`;
  await page.getByTestId('projects-page-new-name').fill(abandonedName);
  await page.getByTestId('projects-page-cancel-create').click();

  // Form collapses back to the start button, and nothing was created.
  await expect(page.getByTestId('projects-page-new-name')).toHaveCount(0);
  await expect(page.getByTestId('projects-page-start-create')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(abandonedName);

  // Reopening the form proves the name was actually cleared, not just hidden.
  await page.getByTestId('projects-page-start-create').click();
  await expect(page.getByTestId('projects-page-new-name')).toHaveValue('');

  const listing = await page.request.get(`${API_BASE_URL}/projects`);
  const projects: Array<{ name: string }> = (await listing.json()).projects;
  expect(projects.some((p) => p.name === abandonedName)).toBe(false);
});

test('warns before discarding unsaved changes when navigating to Projects, and cancelling keeps the work', async ({
  page,
}) => {
  await signIn(page, `/?projectId=${PROJECT_ID}`);
  await openNewDiagram(page);

  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('view-projects').click();
  await expect(page.getByTestId('view-projects-confirm')).toBeVisible();

  await page.getByTestId('cancel-view-projects').click();
  await expect(page.getByTestId('view-projects-confirm')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
});

test('confirming the discard from the unsaved-changes guard leaves the editor for the Projects screen', async ({
  page,
}) => {
  await signIn(page, `/?projectId=${PROJECT_ID}`);
  await openNewDiagram(page);

  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('view-projects').click();
  await expect(page.getByTestId('view-projects-confirm')).toBeVisible();
  await page.getByTestId('confirm-view-projects').click();

  await expect(page.getByTestId('view-projects-confirm')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await expect(page.getByTestId('projects-page-start-create')).toBeVisible();
});

test('the Back button returns to the home screen', async ({ page }) => {
  await signIn(page, `/?projectId=${PROJECT_ID}`);

  await page.getByTestId('view-projects').click();
  await expect(page.getByTestId('close-projects-page')).toBeVisible();

  await page.getByTestId('close-projects-page').click();
  await expect(page.getByTestId('projects-page-start-create')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
  await expect(page.getByTestId('view-projects')).toBeVisible();
});
