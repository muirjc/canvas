import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-t3b.2 (docs/browse-screen-design.md §1-§3, §7, landing rules): location comes from the
 * address, an open diagram is `?diagramId=`, Back/Forward walk screens, and a bare address resumes
 * the last project opened in this browser. Each test makes its own project so names are unique.
 */

async function signIn(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
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

/** A project with one diagram, opened to its Diagrams home. Returns ids and the project's name. */
async function setUpProject(page: Page, label: string) {
  await signIn(page);
  const name = `${label} ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, 'Nav Diagram');
  await page.goto(`/?projectId=${projectId}`);
  await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  return { name, projectId, diagramId };
}

test('opening a diagram puts diagramId in the address and a reload keeps it open', async ({ page }) => {
  const { diagramId } = await setUpProject(page, 'Nav Reload');

  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`diagramId=${diagramId}`));
  expect(new URL(page.url()).searchParams.get('projectId')).toBeNull();

  await page.reload();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`diagramId=${diagramId}`));
});

test('browser Back from the editor returns to the project', async ({ page }) => {
  const { projectId, diagramId } = await setUpProject(page, 'Nav Back');

  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`projectId=${projectId}`));
  await expect(page.getByTestId('new-diagram')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);

  // Forward re-opens the diagram.
  await page.goForward();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`diagramId=${diagramId}`));
});

test('browser Back from an editor with unsaved changes asks first, and cancelling keeps the editor', async ({ page }) => {
  const { projectId, diagramId } = await setUpProject(page, 'Nav Dirty Back');

  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  const nodes = page.locator('[data-testid^="node-"]');
  const before = await nodes.count();
  await page.getByTestId('add-shape-rectangle').click();
  await expect(nodes).toHaveCount(before + 1);

  await page.goBack();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();

  await page.getByTestId('cancel-home-nav').click();
  await expect(page.getByTestId('home-nav-confirm')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(nodes).toHaveCount(before + 1);
  // The popstate was undone: the address still names the diagram.
  await expect(page).toHaveURL(new RegExp(`diagramId=${diagramId}`));

  // Confirming does leave, to the project.
  await page.goBack();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();
  await page.getByTestId('confirm-home-nav').click();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`projectId=${projectId}`));
});

test("the editor's back button is labelled with the project's name", async ({ page }) => {
  const { name, diagramId } = await setUpProject(page, 'Nav Label');

  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('back-to-diagrams')).toContainText(name);
});

test('a bare address resumes the last project opened in this browser', async ({ page }) => {
  const { name, projectId } = await setUpProject(page, 'Nav Resume');

  // Visiting the project recorded it as the landing hint; the seeded admin has many projects.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('canvas.lastProjectId'))).toBe(projectId);

  await page.goto('/');
  await expect(page.getByTestId('new-diagram')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`projectId=${projectId}`));
  await expect(page.getByTestId('project-browser-breadcrumb')).toContainText(name);
});

const WEB_ORIGIN = 'http://localhost:5173';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

/** Fulfils a cross-origin API GET with JSON (the web app sends credentials, so CORS must allow them). */
async function stubApiGet(page: Page, path: string, body: unknown): Promise<void> {
  await page.route(`${API_BASE_URL}${path}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': WEB_ORIGIN, 'access-control-allow-credentials': 'true' },
      body: JSON.stringify(body),
    });
  });
}

const ONLY_PROJECT = {
  id: PROJECT_ID,
  name: 'Smoke Test',
  parentProjectId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  diagramCount: 0,
  ownerId: '00000000-0000-0000-0000-000000000001',
};

const FAKE_SHARED = {
  diagramId: '00000000-0000-0000-0000-0000000000aa',
  diagramName: 'Fake Shared',
  diagramTypeId: 'flowchart',
  projectName: 'Elsewhere',
  accessLevel: 'view',
  sharedByName: 'Someone',
  sharedByEmail: 'someone@example.com',
  sharedAt: '2026-01-01T00:00:00.000Z',
};

test('landing with exactly one project and nothing shared opens that project, and the list stays reachable', async ({ page }) => {
  await stubApiGet(page, '/projects', { projects: [ONLY_PROJECT] });
  await stubApiGet(page, '/shared-diagrams', { diagrams: [] });
  await signIn(page);

  await expect(page).toHaveURL(new RegExp(`projectId=${PROJECT_ID}`));
  await expect(page.getByTestId('project-browser-breadcrumb-current')).toHaveText('Smoke Test');
  await expect(page.getByRole('heading', { level: 1, name: 'Smoke Test' })).toBeVisible();

  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('projectId')).toBeNull();
});

test('landing with exactly one project but something shared stays on the Projects top level', async ({ page }) => {
  await stubApiGet(page, '/projects', { projects: [ONLY_PROJECT] });
  await stubApiGet(page, '/shared-diagrams', { diagrams: [FAKE_SHARED] });
  await signIn(page);

  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await expect(page.getByTestId(`shared-diagram-${FAKE_SHARED.diagramId}`)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('projectId')).toBeNull();
});

test("the editor's back button reads \"Projects\" for a diagram shared from a project the user cannot see", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const architectContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const architectPage = await architectContext.newPage();

  await signIn(adminPage);
  const projectId = await createProject(adminPage, `Nav Hidden ${Date.now()}`);
  const diagramId = await createDiagram(adminPage, projectId, 'Hidden Shared Diagram');
  const lookup = await adminPage.request.get(`${API_BASE_URL}/users/lookup?email=${encodeURIComponent(ARCHITECT_EMAIL)}`);
  const { user } = await lookup.json();
  const share = await adminPage.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, {
    data: { granteeUserId: user.id, accessLevel: 'view' },
  });
  expect(share.status()).toBe(201);
  const grantId = (await share.json()).grant.id;
  const smokeDiagramId = await createDiagram(adminPage, PROJECT_ID!, 'Nav Contrast Diagram');

  try {
    await architectPage.goto('/');
    await architectPage.getByTestId('login-email').fill(ARCHITECT_EMAIL);
    await architectPage.getByTestId('login-password').fill(ARCHITECT_PASSWORD);
    await architectPage.getByTestId('login-submit').click();
    await expect(architectPage.getByTestId('sign-out')).toBeVisible();

    // The landing may resume a project; the shared list lives on the top level.
    await architectPage.getByTestId('nav-projects').click();
    await architectPage.getByTestId(`open-shared-diagram-${diagramId}`).click();
    await expect(architectPage.getByTestId('diagram-canvas')).toBeVisible();

    const back = architectPage.getByTestId('back-to-diagrams');
    await expect(back).toHaveText('Projects');
    await expect(back).toHaveAccessibleName('Back to Projects');
    await back.click();
    await expect(architectPage.getByTestId('projects-page-list')).toBeVisible();
    const url = new URL(architectPage.url());
    expect(url.searchParams.get('projectId')).toBeNull();
    expect(url.searchParams.get('diagramId')).toBeNull();

    // Contrast: a diagram in a project the architect can see is labelled with that project.
    await architectPage.goto(`/?projectId=${PROJECT_ID}`);
    await architectPage.getByTestId(`open-diagram-${smokeDiagramId}`).click();
    await expect(architectPage.getByTestId('diagram-canvas')).toBeVisible();
    await expect(architectPage.getByTestId('back-to-diagrams')).toHaveText('Smoke Test');
  } finally {
    await adminPage.request.delete(`${API_BASE_URL}/shares/${grantId}`);
    await adminContext.close();
    await architectContext.close();
  }
});
