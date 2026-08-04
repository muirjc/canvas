import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-3vq.3. Covers the new client-side filter above ProjectsPage's project list: narrowing by
 * name, the empty-results state, clearing the filter to restore the full list, and that a row
 * action still works on a project visible through an active filter. The dev DB has 600+
 * accumulated test-debris projects (per the bead), so — same precedent as
 * project-browser-search.spec.ts — every test creates its own fixture projects with
 * `Date.now()`-suffixed names rather than asserting against the shared/seeded list.
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

test.describe('projects page filter', () => {
  test('typing a filter that matches one project narrows the list and hides a distractor', async ({ page }) => {
    await signIn(page);
    const suffix = Date.now();
    const matchName = `Filter Match ${suffix}`;
    const distractorName = `Filter Distractor ${suffix}`;
    const matchId = await createProject(page, matchName);
    const distractorId = await createProject(page, distractorName);

    // App's project list is fetched once at load — reload scoped to the seeded project so the
    // list includes the fixtures just created, same precedent as projects-page.spec.ts's own
    // first test.
    await page.goto(`/?projectId=${PROJECT_ID}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await page.getByTestId('view-projects').click();
    await expect(page.getByTestId(`projects-page-row-${matchId}`)).toBeVisible();
    await expect(page.getByTestId(`projects-page-row-${distractorId}`)).toBeVisible();

    await page.getByTestId('projects-page-filter').fill('Filter Match');

    await expect(page.getByTestId(`projects-page-row-${matchId}`)).toBeVisible();
    await expect(page.getByTestId(`projects-page-row-${distractorId}`)).toHaveCount(0);
  });

  test('typing a filter that matches nothing shows the empty state and hides the list', async ({ page }) => {
    await signIn(page);
    await createProject(page, `Filter Empty Source ${Date.now()}`);

    await page.goto(`/?projectId=${PROJECT_ID}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await page.getByTestId('view-projects').click();
    await expect(page.getByTestId('projects-page-list')).toBeVisible();

    await page.getByTestId('projects-page-filter').fill('no-such-project-zzz');

    // Message uses the app's typographic quote convention (matches VersionHistory.tsx's own
    // "No versions match &ldquo;...&rdquo;." message), not straight quotes.
    await expect(page.getByTestId('projects-page-filter-empty')).toContainText('No projects match “no-such-project-zzz”.');
    await expect(page.getByTestId('projects-page-list')).toHaveCount(0);
  });

  test('clearing the filter restores the full list', async ({ page }) => {
    await signIn(page);
    const suffix = Date.now();
    const matchId = await createProject(page, `Filter Clear Match ${suffix}`);
    const distractorId = await createProject(page, `Filter Clear Distractor ${suffix}`);

    await page.goto(`/?projectId=${PROJECT_ID}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await page.getByTestId('view-projects').click();
    await page.getByTestId('projects-page-filter').fill('Filter Clear Match');
    await expect(page.getByTestId(`projects-page-row-${distractorId}`)).toHaveCount(0);

    await page.getByTestId('projects-page-filter').fill('');

    await expect(page.getByTestId('projects-page-list')).toBeVisible();
    await expect(page.getByTestId(`projects-page-row-${matchId}`)).toBeVisible();
    await expect(page.getByTestId(`projects-page-row-${distractorId}`)).toBeVisible();
  });

  test('rename still works on a project visible through an active filter', async ({ page }) => {
    await signIn(page);
    const suffix = Date.now();
    // The renamed name deliberately keeps matching the same filter term afterwards, so this test
    // isolates "does the row action still work while filtered" from the (separate, expected)
    // behavior that a rename which stops matching the active filter would make the row disappear.
    const originalName = `Filter Rename Source ${suffix}`;
    const distractorName = `Filter Rename Distractor ${suffix}`;
    const projectId = await createProject(page, originalName);
    const distractorId = await createProject(page, distractorName);

    await page.goto(`/?projectId=${PROJECT_ID}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await page.getByTestId('view-projects').click();
    await page.getByTestId('projects-page-filter').fill('Filter Rename Source');
    await expect(page.getByTestId(`projects-page-row-${projectId}`)).toBeVisible();
    await expect(page.getByTestId(`projects-page-row-${distractorId}`)).toHaveCount(0);

    await page.getByTestId(`projects-page-rename-${projectId}`).click();
    const renamedName = `Filter Rename Source Updated ${suffix}`;
    const input = page.getByTestId(`projects-page-rename-input-${projectId}`);
    await input.fill(renamedName);
    await input.press('Enter');

    await expect(page.getByTestId(`projects-page-row-${projectId}`)).toContainText(renamedName);
  });
});
