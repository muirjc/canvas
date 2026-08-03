import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-3vq.2. Covers the two additions that close the Projects screen's former dead end:
 * `ProjectsPage`'s new "View Diagrams" button (switches current project and returns to
 * `ProjectBrowser`), and `ProjectBrowser`'s new breadcrumb back to the Projects screen. The
 * breadcrumb only ever renders while `ProjectBrowser` itself is showing (App.tsx renders
 * `ProjectBrowser` only when no diagram is open), so the unsaved-changes-guard case is exercised
 * through the header's own pre-existing "Projects" button (`view-projects`) instead of the
 * breadcrumb — the same `requestViewProjects`/`view-projects-confirm` guard the breadcrumb's
 * `onBackToProjects` reuses, just reached via a path that is actually navigable while a diagram is
 * open. Every test creates its own project so rows/counts can't race against the seeded project's
 * accumulated test debris — same precedent as `project-rename-move.spec.ts` and
 * `project-browser-search.spec.ts`.
 */

async function signIn(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.getByTestId('login-email').fill(OWNER_EMAIL);
  await page.getByTestId('login-password').fill(OWNER_PASSWORD);
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

test.describe('View Diagrams + breadcrumb', () => {
  test('View Diagrams on a Projects-screen row navigates to that project\'s ProjectBrowser, with a breadcrumb naming it', async ({
    page,
  }) => {
    await signIn(page);
    const targetName = `Breadcrumb Target ${Date.now()}`;
    const otherName = `Breadcrumb Other ${Date.now()}`;
    const targetId = await createProject(page, targetName);
    const otherId = await createProject(page, otherName);
    const onlyInTargetId = await createDiagram(page, targetId, 'Only In Target');

    // Land in some other project first, so switching to the target is a real navigation.
    await page.goto(`/?projectId=${otherId}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await expect(page.getByTestId(`open-diagram-${onlyInTargetId}`)).toHaveCount(0);

    await page.getByTestId('view-projects').click();
    await expect(page.getByTestId('projects-page-list')).toBeVisible();

    const targetRow = page.getByTestId(`projects-page-row-${targetId}`);
    await expect(targetRow).toBeVisible();
    await page.getByTestId(`projects-page-view-diagrams-${targetId}`).click();

    // Back on the diagram browser, scoped to the target project.
    await expect(page.getByTestId('projects-page-list')).toHaveCount(0);
    await expect(page.getByTestId('project-browser-breadcrumb')).toBeVisible();
    await expect(page.getByTestId('project-browser-breadcrumb-current')).toHaveText(targetName);
    await expect(page.getByTestId(`open-diagram-${onlyInTargetId}`)).toBeVisible();
  });

  test('the breadcrumb\'s Projects button returns to the Projects screen', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Breadcrumb Back ${Date.now()}`);

    await page.goto(`/?projectId=${projectId}`);
    await expect(page.getByTestId('project-browser-breadcrumb')).toBeVisible();

    await page.getByTestId('project-browser-breadcrumb-back').click();

    await expect(page.getByTestId('projects-page-list')).toBeVisible();
    await expect(page.getByTestId(`projects-page-row-${projectId}`)).toBeVisible();
  });

  test('unsaved changes in an open diagram trigger the same guard confirm dialog whether reached via the breadcrumb\'s shared guard function or the header\'s Projects button', async ({
    page,
  }) => {
    await signIn(page);
    const projectId = await createProject(page, `Breadcrumb Guard ${Date.now()}`);

    await page.goto(`/?projectId=${projectId}`);
    await page.getByTestId('new-diagram').click();
    await page.getByTestId('diagram-type-flowchart').check();
    await page.getByTestId('confirm-new-diagram').click();
    await expect(page.getByTestId('diagram-canvas')).toBeVisible();

    // The breadcrumb is not itself reachable while a diagram is open (ProjectBrowser, and thus its
    // breadcrumb, only renders when App.tsx has no diagram open) — but its onBackToProjects prop is
    // wired to the exact same requestViewProjects guard as the header's own pre-existing "Projects"
    // button, so this exercises the identical shared function from the one path that is actually
    // reachable mid-edit.
    await expect(page.getByTestId('project-browser-breadcrumb')).toHaveCount(0);

    // Make an edit without saving.
    await page.getByTestId('add-shape-rectangle').click();

    await page.getByTestId('view-projects').click();

    const confirmDialog = page.getByTestId('view-projects-confirm');
    await expect(confirmDialog).toBeVisible();

    // Keep editing: dialog closes, diagram stays open, unsaved change survives.
    await page.getByTestId('cancel-view-projects').click();
    await expect(confirmDialog).not.toBeVisible();
    await expect(page.getByTestId('diagram-canvas')).toBeVisible();

    // Trigger again and this time discard — lands on the Projects screen.
    await page.getByTestId('view-projects').click();
    await expect(confirmDialog).toBeVisible();
    await page.getByTestId('confirm-view-projects').click();

    await expect(confirmDialog).not.toBeVisible();
    await expect(page.getByTestId('projects-page-list')).toBeVisible();
  });
});
