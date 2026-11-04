import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { connectShapes } from './helpers/connect';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run the demo seed (python -m canvas_api.jobs.seed_demo) and export it first');

/**
 * canvas-bnnh part 2: Mermaid state diagrams in the editor. A "State Diagram" gets its own toolbar
 * (State, Start, End, Choice, Fork, Join) instead of the generic shapes; pseudo-states draw without
 * a label; a connector can end on a composite state.
 */

async function login(page: Page): Promise<void> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

test('draws a state diagram from the toolbar: start, states, end, connectors, Auto Layout, save', async ({ page }) => {
  await login(page);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-state').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // The state toolbar replaces the generic shapes.
  for (const kind of ['state', 'start', 'end', 'choice', 'fork', 'join']) {
    await expect(page.getByTestId(`add-state-${kind}`)).toBeVisible();
  }
  await expect(page.getByTestId('add-shape-rectangle')).toHaveCount(0);

  await page.getByTestId('add-state-start').click();
  await page.getByTestId('add-state-state').click();
  await page.getByTestId('add-state-state').click();
  await page.getByTestId('add-state-end').click();
  // One start and one end per scope: the buttons switch off.
  await expect(page.getByTestId('add-state-start')).toBeDisabled();
  await expect(page.getByTestId('add-state-end')).toBeDisabled();

  const nodes = page.locator('[data-testid^="node-"]');
  await expect(nodes).toHaveCount(4);
  // A start point draws no label and offers nothing to rename.
  await nodes.nth(0).hover();
  await expect(page.getByTestId('edit-label-root_start')).toHaveCount(0);

  await page.getByTestId('connect-mode-toggle').click();
  await connectShapes(nodes.nth(0), nodes.nth(1));
  await page.getByTestId('connect-mode-toggle').click();
  await connectShapes(nodes.nth(1), nodes.nth(2));
  await page.getByTestId('connect-mode-toggle').click();
  await connectShapes(nodes.nth(2), nodes.nth(3));
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(3);

  const text = await dsl(page);
  expect(text).toContain('stateDiagram-v2');
  expect(text).toMatch(/\[\*\] --> \S+/);
  expect(text).toMatch(/\S+ --> \[\*\]/);

  await page.getByTestId('auto-layout').click();
  await expect(page.getByTestId('save-diagram')).toBeEnabled();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
});

test('a connector can end on a composite state', async ({ page }) => {
  await login(page);
  const project = await page.request.post(`${API_BASE_URL}/projects`, { data: { name: `State composite ${Date.now()}` } });
  const projectId = (await project.json()).project.id as string;
  const created = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: {
      name: 'Composite',
      diagramTypeId: 'state',
      initialDslContent: ['stateDiagram-v2', '  Idle', '  state Active {', '    [*] --> Working', '  }', ''].join('\n'),
    },
  });
  expect(created.status()).toBe(201);
  const diagramId = (await created.json()).diagram.id as string;
  await page.goto(`/?projectId=${projectId}`);
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await expect(page.getByTestId('node-Idle')).toBeVisible();
  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('node-Idle').click();
  await expect(page.getByTestId('node-Idle')).toHaveAttribute('data-connect-source', 'true');
  await page.getByTestId('container-Active').locator('rect').nth(1).click();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(2);
  expect(await dsl(page)).toContain('Idle --> Active');
});
