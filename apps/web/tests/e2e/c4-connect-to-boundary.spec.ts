import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run the demo seed (python -m canvas_api.jobs.seed_demo) and export it first');

/**
 * canvas-lwa4 part 2: in connect mode a C4 boundary can be a connector's end (written as a plain
 * `Rel(person, boundary, "")`), as a state diagram's composite state already could. A flowchart
 * subgraph can too (canvas-pc76).
 */

async function openNewDiagram(page: Page, diagramTypeId: string, initialDslContent: string): Promise<void> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
  const project = await page.request.post(`${API_BASE_URL}/projects`, { data: { name: `Connect to group ${Date.now()}` } });
  const projectId = (await project.json()).project.id as string;
  const created = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name: 'Connect to group', diagramTypeId, initialDslContent },
  });
  expect(created.status()).toBe(201);
  const diagramId = (await created.json()).diagram.id as string;
  await page.goto(`/?projectId=${projectId}`);
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

/** Click the bottom-left corner of a group's box: empty space, clear of the shapes inside it. */
async function clickEmptyPartOfGroup(page: Page, groupId: string): Promise<void> {
  const box = page.locator(`[data-testid="container-${groupId}"] rect`).first();
  const height = Number(await box.getAttribute('height'));
  await box.click({ position: { x: 8, y: height - 8 } });
}

test('a connector can end on a C4 boundary', async ({ page }) => {
  await openNewDiagram(
    page,
    'c4-context',
    [
      'C4Context',
      '  Person(user, "User")',
      '  System_Boundary(bank, "Bank") {',
      '    System(core, "Core banking")',
      '  }',
      '',
    ].join('\n'),
  );

  await expect(page.getByTestId('node-user')).toBeVisible();
  await expect(page.getByTestId('container-bank')).toBeVisible();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(0);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('node-user').click();
  await expect(page.getByTestId('node-user')).toHaveAttribute('data-connect-source', 'true');
  await clickEmptyPartOfGroup(page, 'bank');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  expect(await dsl(page)).toMatch(/Rel\(user, bank\b/);
});

// canvas-pc76: a flowchart link to a subgraph is Mermaid syntax too (`b --> grp`).
test('a flowchart connector can end on a subgraph', async ({ page }) => {
  await openNewDiagram(
    page,
    'flowchart',
    ['flowchart TD', '  subgraph grp[Area]', '    a[Alpha]', '  end', '  b[Beta]', ''].join('\n'),
  );
  await expect(page.getByTestId('node-b')).toBeVisible();
  await expect(page.getByTestId('container-grp')).toBeVisible();

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('node-b').click();
  await expect(page.getByTestId('node-b')).toHaveAttribute('data-connect-source', 'true');
  await clickEmptyPartOfGroup(page, 'grp');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  const text = await dsl(page);
  expect(text).toMatch(/b\s*-->\s*grp\b/);
  // The group is still a group: no stray node named like it.
  await expect(page.getByTestId('node-grp')).toHaveCount(0);
});
