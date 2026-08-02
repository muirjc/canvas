import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';
const GRANTEE_EMAIL = 'architect@example.com';
const GRANTEE_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-228.3. Covers the two new Projects-adjacent actions: renaming a project from the
 * Projects screen (owner-or-admin only, `ProjectsPage.tsx`) and moving a diagram to a different
 * project from the home-screen project browser (edit access on both the diagram and the
 * destination, `ProjectBrowser.tsx`). Backend contract coverage already exists
 * (`apps/api/tests/contract/project-management.test.ts`) — this only exercises the UI wiring.
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

test.describe('project rename', () => {
  test('rename button appears for a project the owner owns; editing then pressing Enter commits it, and the new name survives reopening the Projects screen', async ({
    page,
  }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    const originalName = `Rename Enter ${Date.now()}`;
    const projectId = await createProject(page, originalName);

    await page.goto(`/?projectId=${projectId}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await page.getByTestId('view-projects').click();

    const row = page.getByTestId(`projects-page-row-${projectId}`);
    await expect(row).toBeVisible();
    const renameButton = page.getByTestId(`projects-page-rename-${projectId}`);
    await expect(renameButton).toBeVisible();
    await renameButton.click();

    const input = page.getByTestId(`projects-page-rename-input-${projectId}`);
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(originalName);

    const newName = `${originalName} Renamed`;
    await input.fill(newName);
    await input.press('Enter');

    // Input collapses back to plain text, showing the new name immediately.
    await expect(page.getByTestId(`projects-page-rename-input-${projectId}`)).toHaveCount(0);
    await expect(row).toContainText(newName);

    // Reopening the Projects screen (fresh navigation, so a real reload of server state) proves
    // the rename actually persisted rather than only updating local state.
    await page.reload();
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await page.getByTestId('view-projects').click();
    await expect(page.getByTestId(`projects-page-row-${projectId}`)).toContainText(newName);
  });

  test('Escape cancels the in-progress edit without saving', async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    const originalName = `Rename Escape ${Date.now()}`;
    const projectId = await createProject(page, originalName);

    await page.goto(`/?projectId=${projectId}`);
    await page.getByTestId('view-projects').click();
    await page.getByTestId(`projects-page-rename-${projectId}`).click();

    const input = page.getByTestId(`projects-page-rename-input-${projectId}`);
    await input.fill(`${originalName} Should Not Save`);
    await input.press('Escape');

    await expect(page.getByTestId(`projects-page-rename-input-${projectId}`)).toHaveCount(0);
    const row = page.getByTestId(`projects-page-row-${projectId}`);
    await expect(row).toContainText(originalName);
    await expect(row).not.toContainText('Should Not Save');

    // Confirms the server was never even asked — Escape is a pure client-side cancel, not a
    // revert of a successful write.
    const listing = await page.request.get(`${API_BASE_URL}/projects`);
    const projects: Array<{ id: string; name: string }> = (await listing.json()).projects;
    expect(projects.find((p) => p.id === projectId)?.name).toBe(originalName);
  });

  test('blurring the input (clicking elsewhere) commits the edit, same as Enter', async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    const originalName = `Rename Blur ${Date.now()}`;
    const projectId = await createProject(page, originalName);

    await page.goto(`/?projectId=${projectId}`);
    await page.getByTestId('view-projects').click();
    await page.getByTestId(`projects-page-rename-${projectId}`).click();

    const input = page.getByTestId(`projects-page-rename-input-${projectId}`);
    const newName = `${originalName} Blurred`;
    await input.fill(newName);

    // Click a neutral, non-interactive element to move focus away without pressing Enter.
    await page.getByRole('heading', { name: 'Projects' }).click();

    await expect(page.getByTestId(`projects-page-rename-input-${projectId}`)).toHaveCount(0);
    await expect(page.getByTestId(`projects-page-row-${projectId}`)).toContainText(newName);

    const listing = await page.request.get(`${API_BASE_URL}/projects`);
    const projects: Array<{ id: string; name: string }> = (await listing.json()).projects;
    expect(projects.find((p) => p.id === projectId)?.name).toBe(newName);
  });

  test('the rename button is hidden for a non-owner with only edit access', async ({ page }) => {
    // architect@example.com has a permanent edit-level share grant on the seeded project but does
    // not own it and is not an admin (apps/api/src/seed/run.ts) — exactly the case
    // requireProjectOwnerOrAdmin rejects server-side, mirrored here client-side.
    await signIn(page, GRANTEE_EMAIL, GRANTEE_PASSWORD, `/?projectId=${PROJECT_ID}`);
    await page.getByTestId('view-projects').click();

    const row = page.getByTestId(`projects-page-row-${PROJECT_ID}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`projects-page-rename-${PROJECT_ID}`)).toHaveCount(0);
  });
});

test.describe('move diagram', () => {
  test('the Move dialog lists every other accessible project but not the diagram\'s own current project, and disables Move until a destination is chosen', async ({
    page,
  }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    const originName = `Move Origin ${Date.now()}`;
    const destName = `Move Destination ${Date.now()}`;
    const originId = await createProject(page, originName);
    await createProject(page, destName);
    const diagramId = await createDiagram(page, originId, 'To Be Moved');

    await page.goto(`/?projectId=${originId}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();

    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
    await page.getByTestId(`move-diagram-${diagramId}`).click();

    const dialog = page.getByTestId('move-diagram-dialog');
    await expect(dialog).toBeVisible();

    const select = page.getByTestId('move-diagram-destination');
    const optionLabels = await select.locator('option').allTextContents();
    expect(optionLabels).toContain(destName);
    // The seeded project (admin owns it) is also accessible, proving this is "every other
    // accessible project", not just the one just created.
    expect(optionLabels.some((label) => label.includes('Smoke Test'))).toBe(true);
    expect(optionLabels).not.toContain(originName);

    const confirmButton = page.getByTestId('confirm-move-diagram');
    await expect(confirmButton).toBeDisabled();

    await select.selectOption({ label: destName });
    await expect(confirmButton).toBeEnabled();
  });

  test('confirming a move relocates the diagram; it disappears from the origin project and appears in the destination', async ({
    page,
  }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    const originName = `Move Confirm Origin ${Date.now()}`;
    const destName = `Move Confirm Destination ${Date.now()}`;
    const originId = await createProject(page, originName);
    const destId = await createProject(page, destName);
    const diagramId = await createDiagram(page, originId, 'Move Me');

    await page.goto(`/?projectId=${originId}`);
    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();

    await page.getByTestId(`move-diagram-${diagramId}`).click();
    await page.getByTestId('move-diagram-destination').selectOption({ label: destName });
    await page.getByTestId('confirm-move-diagram').click();

    await expect(page.getByTestId('move-diagram-dialog')).not.toBeVisible();
    // Gone from the origin project's own list.
    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toHaveCount(0);

    // Reappears under the destination project.
    await page.goto(`/?projectId=${destId}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  });

  test('Cancel closes the dialog without moving anything', async ({ page }) => {
    await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
    const originName = `Move Cancel Origin ${Date.now()}`;
    const destName = `Move Cancel Destination ${Date.now()}`;
    const originId = await createProject(page, originName);
    const destId = await createProject(page, destName);
    const diagramId = await createDiagram(page, originId, 'Stay Put');

    await page.goto(`/?projectId=${originId}`);
    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();

    await page.getByTestId(`move-diagram-${diagramId}`).click();
    await page.getByTestId('move-diagram-destination').selectOption({ label: destName });
    await page.getByTestId('cancel-move-diagram').click();

    await expect(page.getByTestId('move-diagram-dialog')).not.toBeVisible();
    // Still in the origin project, unmoved.
    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();

    const tree = await page.request.get(`${API_BASE_URL}/projects/${destId}/tree`);
    const destTree: { diagrams: Array<{ id: string }> } = (await tree.json()).tree;
    expect(destTree.diagrams.some((d) => d.id === diagramId)).toBe(false);
  });
});
