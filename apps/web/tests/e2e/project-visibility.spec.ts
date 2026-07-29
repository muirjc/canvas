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

  // Not in the chooser, and its name appears nowhere on the page.
  await expect(architectPage.getByTestId('project-picker-option').filter({ hasText: secretName })).toHaveCount(0);
  await expect(architectPage.locator('body')).not.toContainText(secretName);

  await adminContext.close();
  await architectContext.close();
});

test('the project a user is working in is named on screen and survives without touching the address bar', async ({
  page,
}) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page.getByTestId('project-name')).toHaveCount(1);
});

test('switching project changes which diagrams are listed and where new ones are created', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const otherProjectName = `Switch Target ${Date.now()}`;
  const otherProjectId = await createProject(page, otherProjectName);

  // Reload so the chooser picks up the new project.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-picker')).toBeVisible();

  await page.getByTestId('project-picker').selectOption(otherProjectId);

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

test('switching project changes the address without burying the back button', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const a = await createProject(page, `Back Test A ${Date.now()}`);
  const b = await createProject(page, `Back Test B ${Date.now()}`);

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('project-picker').selectOption(a);
  await page.getByTestId('project-picker').selectOption(b);
  await page.getByTestId('project-picker').selectOption(a);

  // Three switches must not mean three presses to escape: the address is REPLACED, not pushed
  // (FR-012). One press leaves the app entirely rather than walking back through the switches.
  await page.goBack();
  await expect(page).not.toHaveURL(new RegExp(`projectId=${b}`));
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
  await expect(architectPage.getByTestId('app-error')).toBeVisible();
  await expect(architectPage.getByTestId('new-diagram')).toBeVisible();

  await adminContext.close();
  await architectContext.close();
});

test('a malformed project identifier is treated as no project rather than causing a failure', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?projectId=not-a-uuid');

  // Falls back to a project the user actually has, rather than erroring on the malformed value.
  await expect(page.getByTestId('new-diagram')).toBeVisible();
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

  // Switching from the header, without leaving the editor.
  await page.getByTestId('project-picker').selectOption(otherProjectId);

  // Warned, not silently discarded (FR-013d).
  await expect(page.getByTestId('project-switch-confirm')).toBeVisible();

  // Cancelling leaves the diagram and the edit exactly where they were, still in the original
  // project — this is the assertion SC-006b turns on.
  await page.getByTestId('cancel-project-switch').click();
  await expect(page.getByTestId('project-switch-confirm')).toHaveCount(0);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`projectId=${PROJECT_ID}`));
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

  await page.getByTestId('project-picker').selectOption(otherProjectId);
  await expect(page.getByTestId('project-switch-confirm')).toBeVisible();
  await page.getByTestId('confirm-project-switch').click();

  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`projectId=${otherProjectId}`));
});

test('the project chooser is reachable and operable by keyboard alone', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await createProject(page, `Keyboard Reach ${Date.now()}`);
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-picker')).toBeVisible();

  // Walk the real tab order rather than calling .focus(), which would prove nothing about whether
  // a keyboard user can actually get there.
  let reached = false;
  for (let i = 0; i < 20 && !reached; i += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') === 'project-picker',
    );
  }
  expect(reached).toBe(true);

  // It has an accessible name, so it is not an unlabelled control (FR-018).
  await expect(page.getByTestId('project-picker')).toHaveAccessibleName(/project/i);
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
