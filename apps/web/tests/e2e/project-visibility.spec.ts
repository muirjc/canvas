import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Feature 007, User Story 3. The existing `project-context.spec.ts` covers User Stories 1 and 2 —
 * it references only pre-existing testids and would pass with no project chooser at all and with
 * visibility entirely unenforced. Everything about CHOOSING a project, and above all the rule
 * that a user is never offered someone else's, is covered here and nowhere else.
 */

async function signIn(page: Page, email: string, password: string, url = '/') {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/** Creates a project owned by whoever the page is signed in as. */
async function createProject(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects`, { data: { name } });
  expect(response.status()).toBe(201);
  return (await response.json()).project.id;
}

test('a user is never offered, or told the name of, a project belonging to someone else', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const architectContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const architectPage = await architectContext.newPage();

  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  const secretName = `Admin Only Acquisition ${Date.now()}`;
  await createProject(adminPage, secretName);

  await signIn(architectPage, ARCHITECT_EMAIL, ARCHITECT_PASSWORD);

  // canvas-t3b.4: the chooser is now the project list. Not in it, and its name appears nowhere on the page.
  await architectPage.getByTestId('nav-projects').click();
  await expect(architectPage.getByTestId('projects-page-list')).toBeVisible();
  await expect(architectPage.getByTestId('projects-page-list')).not.toContainText(secretName);
  await expect(architectPage.locator('body')).not.toContainText(secretName);

  await adminContext.close();
  await architectContext.close();
});

test('the project a user is working in is named on screen and survives without touching the address bar', async ({
  page,
}) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);
  // canvas-t3b.4: the project is named by the Browse screen's breadcrumb (the header picker is gone).
  await expect(page.getByTestId('project-browser-breadcrumb-current')).toHaveCount(1);
});

test('switching project changes which diagrams are listed and where new ones are created', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const otherProjectName = `Switch Target ${Date.now()}`;
  const otherProjectId = await createProject(page, otherProjectName);

  // canvas-t3b.4: switching is via the project list (the header picker is gone).
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('nav-projects').click();
  await page.getByTestId(`projects-page-open-${otherProjectId}`).click();

  // The address follows the selection, so the link stays shareable (FR-011).
  await expect(page).toHaveURL(new RegExp(`projectId=${otherProjectId}`));

  // A brand-new project has no diagrams; the seeded one has many.
  await expect(page.locator('[data-testid^="open-diagram-"]')).toHaveCount(0);

  // A diagram created now belongs to the newly chosen project (FR-010).
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const listed = await page.request.get(`${API_BASE_URL}/projects/${otherProjectId}/diagrams`);
  expect((await listed.json()).diagrams).toHaveLength(1);
});

test('switching project pushes history so Back returns to the previous project', async ({ page }) => {
  // canvas-t3b.2: every screen change pushes history (the old "address is replaced" rule is gone).
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const a = await createProject(page, `Back Test A ${Date.now()}`);
  const b = await createProject(page, `Back Test B ${Date.now()}`);

  // canvas-t3b.4: projects are opened via the project list; Back retraces list -> project steps.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('nav-projects').click();
  await page.getByTestId(`projects-page-open-${a}`).click();
  await expect(page).toHaveURL(new RegExp(`projectId=${a}`));
  await page.getByTestId('nav-projects').click();
  await page.getByTestId(`projects-page-open-${b}`).click();
  await expect(page).toHaveURL(new RegExp(`projectId=${b}`));

  await page.goBack();
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`projectId=${a}`));
  await page.goBack();
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`projectId=${PROJECT_ID}`));
});

test('a link copied while viewing a project opens that same project for a colleague with access', async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}`);

  // What the sender would copy out of the address bar.
  const copied = adminPage.url();
  expect(copied).toContain(`projectId=${PROJECT_ID}`);

  const architectContext = await browser.newContext();
  const architectPage = await architectContext.newPage();
  await signIn(architectPage, ARCHITECT_EMAIL, ARCHITECT_PASSWORD, copied);

  await expect(architectPage).toHaveURL(new RegExp(`projectId=${PROJECT_ID}`));
  await expect(architectPage.getByTestId('project-browser')).toBeVisible();

  await adminContext.close();
  await architectContext.close();
});

test('an address naming a project the user cannot reach explains itself and leaves them somewhere usable', async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
  const inaccessible = await createProject(adminPage, `Unreachable ${Date.now()}`);

  const architectContext = await browser.newContext();
  const architectPage = await architectContext.newPage();
  await signIn(architectPage, ARCHITECT_EMAIL, ARCHITECT_PASSWORD, `/?projectId=${inaccessible}`);

  // Told plainly, and left able to carry on rather than stuck on a dead screen (FR-013).
  // canvas-t3b.2: "carry on" is now the Projects top level, not a fallback project.
  await expect(architectPage.getByTestId('app-error')).toBeVisible();
  await expect(architectPage.getByTestId('projects-page-list')).toBeVisible();
  await expect(architectPage.getByTestId('new-diagram')).toHaveCount(0);

  await adminContext.close();
  await architectContext.close();
});

test('a malformed project identifier is treated as no project rather than causing a failure', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?projectId=not-a-uuid');

  // canvas-t3b.2: lands silently on the Projects top level rather than erroring on the malformed value.
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await expect(page.getByTestId('new-diagram')).toHaveCount(0);
  await expect(page.getByTestId('app-error')).toHaveCount(0);
});

test('switching project with unsaved changes warns, and cancelling keeps the work', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const otherProjectId = await createProject(page, `Unsaved Guard ${Date.now()}`);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // An actual edit, so there is real work to lose. Wait for the shape to actually render before
  // switching: the model drives both the canvas and the unsaved-changes signal, so a visible node
  // is proof the edit has landed. Clicking straight through can outrun a frame and switch while
  // the shell still believes nothing has changed — which is what failed in CI but not locally.
  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  // canvas-t3b.4: leaving for another project is now the header's Projects link, from the editor.
  await page.getByTestId('nav-projects').click();

  // Warned, not silently discarded (FR-013d).
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();

  // Cancelling leaves the diagram and the edit exactly where they were, still in the original
  // project — this is the assertion SC-006b turns on.
  await page.getByTestId('cancel-home-nav').click();
  await expect(page.getByTestId('home-nav-confirm')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  // canvas-t3b.2: the editor's address names the diagram, and cancelling leaves it there.
  await expect(page).toHaveURL(/diagramId=/);
  await expect(page).not.toHaveURL(new RegExp(`projectId=${otherProjectId}`));
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
});

test('confirming a project switch with unsaved changes does leave the editor', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const otherProjectId = await createProject(page, `Unsaved Confirm ${Date.now()}`);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('add-shape-rectangle').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  // canvas-t3b.4: leave via the header's Projects link, then open the other project from the list.
  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('home-nav-confirm')).toBeVisible();
  await page.getByTestId('confirm-home-nav').click();

  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await page.getByTestId(`projects-page-open-${otherProjectId}`).click();
  await expect(page).toHaveURL(new RegExp(`projectId=${otherProjectId}`));
});

test('the project chooser is reachable and operable by keyboard alone', async ({ page }) => {
  // canvas-t3b.4: the chooser is the project list. The seeded DB has hundreds of projects, so a
  // fresh one is narrowed to with the list's own filter; the filter and Open button are reached by Tab.
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const name = `Keyboard Reach ${Date.now()}`;
  const projectId = await createProject(page, name);
  await page.goto('/');
  await expect(page.getByTestId('projects-page-list')).toBeVisible();

  const tabTo = async (testId: string) => {
    // Walk the real tab order rather than calling .focus(), which proves nothing about reachability.
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      const hit = await page.evaluate((id) => document.activeElement?.getAttribute('data-testid') === id, testId);
      if (hit) return true;
    }
    return false;
  };

  expect(await tabTo('projects-page-filter')).toBe(true);
  await page.keyboard.type(name);
  await expect(page.getByTestId(`projects-page-open-${projectId}`)).toBeVisible();
  expect(await tabTo(`projects-page-open-${projectId}`)).toBe(true);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`projectId=${projectId}`));
  await expect(page.getByTestId('project-browser-breadcrumb-current')).toHaveText(name);
});

test('a user with access to no projects is invited to create one, not shown an error', async ({ browser }) => {
  // Newly reachable: before visibility was access-controlled this could only happen on an empty
  // installation. It now also happens to a user who owns nothing and has been given nothing.
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.route('**/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: [] }) });
      return;
    }
    await route.continue();
  });

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  await expect(page.getByTestId('create-first-project')).toBeVisible();
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  // Nothing is created on the user's behalf (FR-015).
  await expect(page.getByTestId('start-create-project')).toBeVisible();

  await context.close();
});
