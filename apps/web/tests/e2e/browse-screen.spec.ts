import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-t3b.3 (docs/browse-screen-design.md "Screen layouts", "Accessibility and focus"): the
 * unified Browse screen. Each test makes its own project so names/ids are unique.
 */

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD, url = '/'): Promise<void> {
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

/** Whether the screen's [data-browse-heading] h1 currently holds focus. */
async function headingFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return !!active && active.matches('h1[data-browse-heading]');
  });
}

/** Lands on the Projects top level regardless of landing-rule redirects. */
async function gotoTopLevel(page: Page): Promise<void> {
  if (!(await page.getByTestId('projects-page-list').isVisible())) {
    await page.getByTestId('view-projects').click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
}

async function setUp(page: Page, label: string) {
  await signIn(page);
  const name = `${label} ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramName = `${label} Diagram`;
  const diagramId = await createDiagram(page, projectId, diagramName);
  await page.goto('/');
  await gotoTopLevel(page);
  await page.getByTestId('projects-page-filter').fill(name);
  await expect(page.getByTestId(`projects-page-row-${projectId}`)).toBeVisible();
  return { name, projectId, diagramName, diagramId };
}

test('top level: the filter comes before New Project in the tab order', async ({ page }) => {
  await setUp(page, 'Browse Tab');
  await page.getByRole('heading', { level: 1, name: 'Projects' }).focus();

  await page.keyboard.press('Tab');
  await expect(page.getByTestId('projects-page-filter')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('projects-page-start-create')).toBeFocused();
});

test('a project name is a real link that navigates in-app on a plain click; breadcrumb and h1 name the project', async ({
  page,
}) => {
  const { name, projectId } = await setUp(page, 'Browse Link');
  const link = page.getByTestId(`projects-page-name-${projectId}`);
  await expect(link).toHaveAttribute('href', new RegExp(`projectId=${projectId}`));

  let reloaded = false;
  page.on('load', () => {
    reloaded = true;
  });
  await link.click();

  await expect(page).toHaveURL(new RegExp(`projectId=${projectId}`));
  await expect(page.getByTestId('project-browser-breadcrumb')).toBeVisible();
  expect(reloaded).toBe(false);

  // Breadcrumb structure: nav > ol > "Projects" link (real href) then the current page item.
  const nav = page.getByRole('navigation', { name: 'Breadcrumb' });
  const items = nav.locator('ol > li');
  await expect(items).toHaveCount(2);
  const back = page.getByTestId('project-browser-breadcrumb-back');
  await expect(back).toHaveText('Projects');
  await expect(back).toHaveAttribute('href', /.+/);
  expect(await back.evaluate((el) => el.tagName)).toBe('A');
  const current = page.getByTestId('project-browser-breadcrumb-current');
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current).toHaveText(name);
  expect(await current.evaluate((el) => el.parentElement?.lastElementChild === el)).toBe(true);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
});

test('focus moves to the h1 after drilling in, the breadcrumb back, and browser Back; and onto the editor h1 on open', async ({
  page,
}) => {
  const { name, projectId, diagramName, diagramId } = await setUp(page, 'Browse Focus');

  await page.getByTestId(`projects-page-open-${projectId}`).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeFocused();
  expect(await headingFocused(page)).toBe(true);

  await page.getByTestId('project-browser-breadcrumb-back').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeFocused();

  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name })).toBeFocused();

  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  const editorHeading = page.getByRole('heading', { level: 1, name: diagramName });
  await expect(editorHeading).toBeFocused();
  expect(await headingFocused(page)).toBe(true);
});

test('initial page load does not move focus to the h1', async ({ page }) => {
  const { projectId, name } = await setUp(page, 'Browse Initial');

  await page.goto(`/?projectId=${projectId}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  // Give the (bounded, 500ms) heading-focus retry loop time to wrongly fire.
  await page.waitForFunction(() => document.readyState === 'complete');
  expect(await headingFocused(page)).toBe(false);
  await expect(page.getByRole('heading', { level: 1, name })).not.toBeFocused();
});

test('document.title names each screen', async ({ page }) => {
  const { name, projectId, diagramName, diagramId } = await setUp(page, 'Browse Title');
  await expect(page).toHaveTitle('Projects – Canvas');

  await page.getByTestId(`projects-page-open-${projectId}`).click();
  await expect(page).toHaveTitle(`${name} – Canvas`);

  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page).toHaveTitle(`${diagramName} – Canvas`);
});

test('row buttons carry accessible names including the project / diagram name; diagram rows show their type', async ({
  page,
}) => {
  const { name, projectId, diagramName, diagramId } = await setUp(page, 'Browse Names');

  await expect(page.getByRole('button', { name: `Open project ${name}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Rename project ${name}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Delete project ${name}` })).toBeVisible();
  await expect(page.getByRole('link', { name })).toHaveAttribute('href', new RegExp(projectId));

  await page.getByTestId(`projects-page-open-${projectId}`).click();
  await expect(page.getByRole('button', { name: `Open diagram ${diagramName}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Move diagram ${diagramName}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Delete diagram ${diagramName}` })).toBeVisible();

  const row = page.getByTestId(`open-diagram-${diagramId}`).locator('xpath=ancestor::li[1]');
  await expect(row.locator('.meta')).toContainText(/flowchart/i);
});

test('"Shared with me" is on the top level and not on a project page for a user with projects', async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const architectContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const architectPage = await architectContext.newPage();

  await signIn(adminPage);
  const projectId = await createProject(adminPage, `Browse Shared Source ${Date.now()}`);
  const diagramId = await createDiagram(adminPage, projectId, `Browse Shared Diagram ${Date.now()}`);
  const lookup = await adminPage.request.get(`${API_BASE_URL}/users/lookup?email=${encodeURIComponent(ARCHITECT_EMAIL)}`);
  const { user } = await lookup.json();
  const share = await adminPage.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, {
    data: { granteeUserId: user.id, accessLevel: 'view' },
  });
  expect(share.status()).toBe(201);
  const grantId = (await share.json()).grant.id;

  try {
    await signIn(architectPage, ARCHITECT_EMAIL, ARCHITECT_PASSWORD);
    // The architect has project access, so the invitation never shows and the list is on top level.
    await gotoTopLevel(architectPage);
    await expect(architectPage.getByTestId('projects-page-list')).toBeVisible();
    const shared = architectPage.getByTestId('shared-diagrams');
    await expect(shared).toBeVisible();
    await expect(shared.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
    await expect(architectPage.getByTestId(`shared-diagram-${diagramId}`)).toBeVisible();
    await expect(architectPage.getByTestId(`shared-diagram-shared-by-${diagramId}`)).toContainText('Admin');

    await architectPage.goto(`/?projectId=${PROJECT_ID}`);
    await expect(architectPage.getByTestId('project-browser-breadcrumb')).toBeVisible();
    await expect(architectPage.getByTestId('shared-diagrams')).toHaveCount(0);
  } finally {
    await adminPage.request.delete(`${API_BASE_URL}/shares/${grantId}`);
    await adminContext.close();
    await architectContext.close();
  }
});

test('renaming a project returns focus to that row\'s Rename button', async ({ page }) => {
  const { projectId, name } = await setUp(page, 'Browse Rename');

  await page.getByTestId(`projects-page-rename-${projectId}`).click();
  const input = page.getByTestId(`projects-page-rename-input-${projectId}`);
  await expect(input).toBeFocused();
  const newName = `${name} renamed`;
  await input.fill(newName);
  await input.press('Enter');

  const renameButton = page.getByTestId(`projects-page-rename-${projectId}`);
  await expect(renameButton).toBeFocused();
  await expect(page.getByTestId(`projects-page-name-${projectId}`)).toHaveText(newName);
});
