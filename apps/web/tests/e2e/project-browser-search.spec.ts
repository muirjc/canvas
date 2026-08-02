import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-3vq.1. Covers the new search input + diagram-type filter above `ProjectBrowser`'s tree
 * view: narrowing by name, narrowing by type, combining both, the empty-results state, returning
 * to the tree view once cleared, and that Open/Move/Delete on a flat search-result row behave
 * exactly like they do on a tree row (shared `DiagramRow` component). Every test creates its own
 * project so counts/rows can't race with other specs or the seeded project's accumulated data —
 * same precedent as `project-rename-move.spec.ts`.
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

async function createDiagram(page: Page, projectId: string, name: string, diagramTypeId = 'flowchart'): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name, diagramTypeId },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).diagram.id;
}

test.describe('project browser search/filter', () => {
  test('typing a search term that matches an existing diagram narrows the list to just that diagram', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Search Match ${Date.now()}`);
    const matchId = await createDiagram(page, projectId, 'Order Fulfillment Flow');
    const otherId = await createDiagram(page, projectId, 'Customer Onboarding');

    await page.goto(`/?projectId=${projectId}`);
    await expect(page.getByTestId('project-browser')).toBeVisible();
    await expect(page.getByTestId(`open-diagram-${matchId}`)).toBeVisible();
    await expect(page.getByTestId(`open-diagram-${otherId}`)).toBeVisible();

    await page.getByTestId('project-browser-search').fill('Fulfillment');

    const results = page.getByTestId('project-browser-search-results');
    await expect(results).toBeVisible();
    await expect(results.getByTestId(`open-diagram-${matchId}`)).toBeVisible();
    await expect(results.getByTestId(`open-diagram-${otherId}`)).toHaveCount(0);
    await expect(page.getByTestId('project-browser')).toHaveCount(0);
  });

  test('typing a search term that matches nothing shows the empty-results state', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Search Empty ${Date.now()}`);
    await createDiagram(page, projectId, 'Only Diagram Here');

    await page.goto(`/?projectId=${projectId}`);
    await expect(page.getByTestId('project-browser')).toBeVisible();

    await page.getByTestId('project-browser-search').fill('no-such-diagram-zzz');

    await expect(page.getByTestId('project-browser-search-empty')).toContainText('No diagrams match your search.');
    await expect(page.getByTestId('project-browser-search-results')).toHaveCount(0);
  });

  test('clearing the search field returns to the original tree view', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Search Clear ${Date.now()}`);
    const diagramId = await createDiagram(page, projectId, 'Back To Tree');

    await page.goto(`/?projectId=${projectId}`);
    await expect(page.getByTestId('project-browser')).toBeVisible();

    await page.getByTestId('project-browser-search').fill('Back To Tree');
    await expect(page.getByTestId('project-browser-search-results')).toBeVisible();
    await expect(page.getByTestId('project-browser')).toHaveCount(0);

    await page.getByTestId('project-browser-search').fill('');

    await expect(page.getByTestId('project-browser')).toBeVisible();
    await expect(page.getByTestId('project-browser-search-results')).toHaveCount(0);
    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  });

  test('selecting a diagram type in the filter narrows results to diagrams of that type', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Type Filter ${Date.now()}`);
    const flowId = await createDiagram(page, projectId, 'A Flowchart Diagram', 'flowchart');
    const seqId = await createDiagram(page, projectId, 'A Sequence Diagram', 'sequence');

    await page.goto(`/?projectId=${projectId}`);
    await expect(page.getByTestId('project-browser')).toBeVisible();

    const typeFilter = page.getByTestId('project-browser-type-filter');
    await expect(typeFilter.locator('option', { hasText: 'All types' })).toHaveCount(1);
    await typeFilter.selectOption('sequence');

    const results = page.getByTestId('project-browser-search-results');
    await expect(results).toBeVisible();
    await expect(results.getByTestId(`open-diagram-${seqId}`)).toBeVisible();
    await expect(results.getByTestId(`open-diagram-${flowId}`)).toHaveCount(0);
  });

  test('combining search text and a type filter narrows further (AND semantics)', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Combined Filter ${Date.now()}`);
    const comboSeqId = await createDiagram(page, projectId, 'Combo Match', 'sequence');
    const comboFlowId = await createDiagram(page, projectId, 'Combo Match', 'flowchart');
    const otherSeqId = await createDiagram(page, projectId, 'Unrelated Name', 'sequence');

    await page.goto(`/?projectId=${projectId}`);
    await expect(page.getByTestId('project-browser')).toBeVisible();

    await page.getByTestId('project-browser-search').fill('Combo Match');
    await page.getByTestId('project-browser-type-filter').selectOption('sequence');

    const results = page.getByTestId('project-browser-search-results');
    await expect(results).toBeVisible();
    await expect(results.getByTestId(`open-diagram-${comboSeqId}`)).toBeVisible();
    await expect(results.getByTestId(`open-diagram-${comboFlowId}`)).toHaveCount(0);
    await expect(results.getByTestId(`open-diagram-${otherSeqId}`)).toHaveCount(0);
  });

  test('Open on a flat search-result row opens the diagram, same as a tree row', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Search Open ${Date.now()}`);
    const diagramId = await createDiagram(page, projectId, 'Open Me From Search');

    await page.goto(`/?projectId=${projectId}`);
    await page.getByTestId('project-browser-search').fill('Open Me From Search');

    const results = page.getByTestId('project-browser-search-results');
    await expect(results).toBeVisible();
    await results.getByTestId(`open-diagram-${diagramId}`).click();

    await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  });

  test('Move on a flat search-result row relocates the diagram to a different project', async ({ page }) => {
    await signIn(page);
    const originName = `Search Move Origin ${Date.now()}`;
    const destName = `Search Move Destination ${Date.now()}`;
    const originId = await createProject(page, originName);
    const destId = await createProject(page, destName);
    const diagramId = await createDiagram(page, originId, 'Move Me Via Search');

    await page.goto(`/?projectId=${originId}`);
    await page.getByTestId('project-browser-search').fill('Move Me Via Search');

    const results = page.getByTestId('project-browser-search-results');
    await expect(results).toBeVisible();
    await results.getByTestId(`move-diagram-${diagramId}`).click();

    const dialog = page.getByTestId('move-diagram-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('move-diagram-destination').selectOption({ label: destName });
    await page.getByTestId('confirm-move-diagram').click();

    await expect(page.getByTestId('move-diagram-dialog')).not.toBeVisible();
    // The search itself re-runs after a successful move, so the row disappears from the origin
    // project's own (still-filtered) results without needing to clear the search box first.
    await expect(page.getByTestId('project-browser-search-results').getByTestId(`open-diagram-${diagramId}`)).toHaveCount(0);

    await page.goto(`/?projectId=${destId}`);
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  });

  test('Delete on a flat search-result row removes the diagram, same as a tree row', async ({ page }) => {
    await signIn(page);
    const projectId = await createProject(page, `Search Delete ${Date.now()}`);
    const diagramId = await createDiagram(page, projectId, 'Delete Me Via Search');

    await page.goto(`/?projectId=${projectId}`);
    await page.getByTestId('project-browser-search').fill('Delete Me Via Search');

    const results = page.getByTestId('project-browser-search-results');
    await expect(results).toBeVisible();
    await results.getByTestId(`delete-diagram-${diagramId}`).click();

    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-dialog-confirm').click();

    // Search re-runs after the delete, same "no need to clear the box" behavior as Move above.
    await expect(page.getByTestId('project-browser-search-empty')).toBeVisible();
  });
});
