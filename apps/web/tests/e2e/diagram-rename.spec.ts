import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-8x1: renaming a diagram via the doc-bar's click-to-edit title (`DiagramEditor.tsx`),
 * mirroring `project-rename-move.spec.ts`'s per-test-isolation style. Backend contract coverage
 * already exists (`apps/api/tests/contract/diagram-rename.test.ts`) — this only exercises the UI
 * wiring and the "shows up back in ProjectBrowser" acceptance criterion.
 */

async function signIn(page: Page, email: string, password: string, url = '/'): Promise<void> {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

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

async function openDiagram(page: Page, projectId: string, diagramId: string): Promise<void> {
  await page.goto(`/?projectId=${projectId}`);
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('clicking the diagram title reveals an editable input pre-filled with the current name', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const originalName = `Rename Reveal ${Date.now()}`;
  const projectId = await createProject(page, originalName);
  const diagramId = await createDiagram(page, projectId, originalName);
  await openDiagram(page, projectId, diagramId);

  await expect(page.getByTestId('diagram-title')).toHaveText(originalName);
  await expect(page.getByTestId('diagram-title-input')).toHaveCount(0);

  await page.getByTestId('diagram-title').click();

  const input = page.getByTestId('diagram-title-input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(originalName);
});

test('typing a new name and pressing Enter commits it', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const originalName = `Rename Enter ${Date.now()}`;
  const projectId = await createProject(page, originalName);
  const diagramId = await createDiagram(page, projectId, originalName);
  await openDiagram(page, projectId, diagramId);

  await page.getByTestId('diagram-title').click();
  const input = page.getByTestId('diagram-title-input');
  const newName = `${originalName} Renamed`;
  await input.fill(newName);
  await input.press('Enter');

  await expect(page.getByTestId('diagram-title-input')).toHaveCount(0);
  await expect(page.getByTestId('diagram-title')).toHaveText(newName);

  // Persisted server-side, not just local state — confirmed via a fresh GET.
  const getResponse = await page.request.get(`${API_BASE_URL}/diagrams/${diagramId}`);
  expect((await getResponse.json()).diagram.name).toBe(newName);
});

test('typing a new name and blurring (clicking elsewhere) also commits it', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const originalName = `Rename Blur ${Date.now()}`;
  const projectId = await createProject(page, originalName);
  const diagramId = await createDiagram(page, projectId, originalName);
  await openDiagram(page, projectId, diagramId);

  await page.getByTestId('diagram-title').click();
  const input = page.getByTestId('diagram-title-input');
  const newName = `${originalName} Blurred`;
  await input.fill(newName);

  // Click a neutral, non-interactive element to move focus away without pressing Enter.
  await page.getByTestId('save-status').click();

  await expect(page.getByTestId('diagram-title-input')).toHaveCount(0);
  await expect(page.getByTestId('diagram-title')).toHaveText(newName);

  const getResponse = await page.request.get(`${API_BASE_URL}/diagrams/${diagramId}`);
  expect((await getResponse.json()).diagram.name).toBe(newName);
});

test('Escape cancels the in-progress edit without saving', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const originalName = `Rename Escape ${Date.now()}`;
  const projectId = await createProject(page, originalName);
  const diagramId = await createDiagram(page, projectId, originalName);
  await openDiagram(page, projectId, diagramId);

  await page.getByTestId('diagram-title').click();
  const input = page.getByTestId('diagram-title-input');
  await input.fill(`${originalName} Should Not Save`);
  await input.press('Escape');

  await expect(page.getByTestId('diagram-title-input')).toHaveCount(0);
  await expect(page.getByTestId('diagram-title')).toHaveText(originalName);

  // Confirms the server was never even asked — Escape is a pure client-side cancel.
  const getResponse = await page.request.get(`${API_BASE_URL}/diagrams/${diagramId}`);
  expect((await getResponse.json()).diagram.name).toBe(originalName);
});

test('submitting a blank/whitespace-only name is a no-op — name unchanged, no error shown', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const originalName = `Rename Blank ${Date.now()}`;
  const projectId = await createProject(page, originalName);
  const diagramId = await createDiagram(page, projectId, originalName);
  await openDiagram(page, projectId, diagramId);

  await page.getByTestId('diagram-title').click();
  const input = page.getByTestId('diagram-title-input');
  await input.fill('   ');
  await input.press('Enter');

  await expect(page.getByTestId('diagram-title-input')).toHaveCount(0);
  await expect(page.getByTestId('diagram-title')).toHaveText(originalName);
  await expect(page.getByTestId('diagram-rename-error')).toHaveCount(0);

  const getResponse = await page.request.get(`${API_BASE_URL}/diagrams/${diagramId}`);
  expect((await getResponse.json()).diagram.name).toBe(originalName);
});

test('the renamed name is reflected back in ProjectBrowser after navigating back via Diagrams', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const originalName = `Rename Roundtrip ${Date.now()}`;
  const projectId = await createProject(page, originalName);
  const diagramId = await createDiagram(page, projectId, originalName);
  await openDiagram(page, projectId, diagramId);

  await page.getByTestId('diagram-title').click();
  const input = page.getByTestId('diagram-title-input');
  const newName = `${originalName} Reflected`;
  await input.fill(newName);
  await input.press('Enter');
  await expect(page.getByTestId('diagram-title')).toHaveText(newName);

  await page.getByTestId('back-to-diagrams').click();
  await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  // Scoped to the diagram's own row (`li.row`, DiagramRow in ProjectBrowser.tsx) rather than any
  // ancestor `<li>` — the project tree also nests an outer `li.project-node` around it, which
  // would otherwise ambiguously match too.
  const row = page.locator('li.row', { has: page.getByTestId(`open-diagram-${diagramId}`) });
  await expect(row).toContainText(newName);
});

test('the diagram title affordance has an accessible name and is keyboard reachable', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const originalName = `Rename A11y ${Date.now()}`;
  const projectId = await createProject(page, originalName);
  const diagramId = await createDiagram(page, projectId, originalName);
  await openDiagram(page, projectId, diagramId);

  const titleButton = page.getByTestId('diagram-title');
  // A real <button> whose accessible name comes from its own text content — never an
  // unlabelled icon-only control, which would fail an axe accessible-name check.
  await expect(titleButton).toHaveText(originalName);
  await expect(titleButton).toHaveRole('button');

  await titleButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('diagram-title-input')).toBeVisible();
});
