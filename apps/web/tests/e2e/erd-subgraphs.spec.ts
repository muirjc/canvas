import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run the demo seed (python -m canvas_api.jobs.seed_demo) and export it first');

/**
 * canvas-lwa4 part 4: ER diagrams read, keep and write Mermaid subgraphs (groups). Before, the editor
 * offered "Group into Container" for ER diagrams but saving dropped the group.
 */

async function openNewDiagram(page: Page, initialDslContent: string): Promise<void> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
  const project = await page.request.post(`${API_BASE_URL}/projects`, { data: { name: `ER subgraphs ${Date.now()}` } });
  const projectId = (await project.json()).project.id as string;
  const created = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name: 'ER subgraphs', diagramTypeId: 'erd', initialDslContent },
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

test('a group made around two ER entities survives save and reload', async ({ page }) => {
  await openNewDiagram(page, ['erDiagram', '  CUSTOMER ||--o{ ORDER : places', ''].join('\n'));
  await expect(page.getByTestId('node-CUSTOMER')).toBeVisible();
  await expect(page.getByTestId('node-ORDER')).toBeVisible();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(0);

  await page.getByTestId('node-CUSTOMER').click();
  await page.getByTestId('node-ORDER').click({ modifiers: ['Shift'] });
  await page.getByTestId('group-selected').click();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(1);

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('node-CUSTOMER')).toBeVisible();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(1);

  await expect
    .poll(async () => dsl(page))
    .toMatch(/subgraph [^\n]*\n(?=[\s\S]*\bCUSTOMER\b)(?=[\s\S]*\bORDER\b)[\s\S]*\n\s*end\b/);
  const text = await dsl(page);
  const block = text.slice(text.indexOf('subgraph'), text.lastIndexOf('end') + 3);
  expect(block).toMatch(/\bCUSTOMER\b/);
  expect(block).toMatch(/\bORDER\b/);
});

test('a connector can end on an ER subgraph', async ({ page }) => {
  await openNewDiagram(page, ['erDiagram', '  subgraph Sales', '    CUSTOMER', '  end', '  ORDER', ''].join('\n'));
  await expect(page.getByTestId('node-ORDER')).toBeVisible();
  await expect(page.getByTestId('container-Sales')).toBeVisible();
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(0);

  await page.getByTestId('connect-mode-toggle').click();
  await page.getByTestId('node-ORDER').click();
  await expect(page.getByTestId('node-ORDER')).toHaveAttribute('data-connect-source', 'true');
  await clickEmptyPartOfGroup(page, 'Sales');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);
  expect(await dsl(page)).toMatch(/ORDER \S+ Sales : /);
});

test('nested subgraphs and a quoted id show their titles on the canvas', async ({ page }) => {
  await openNewDiagram(
    page,
    [
      'erDiagram',
      '  subgraph "Customer Domain" [Customers]',
      '    CUSTOMER',
      '    subgraph Inner [Addresses]',
      '      ADDRESS',
      '    end',
      '  end',
      '  CUSTOMER ||--o{ ADDRESS : has',
      '',
    ].join('\n'),
  );
  await expect(page.getByTestId('node-CUSTOMER')).toBeVisible();
  await expect(page.getByTestId('node-ADDRESS')).toBeVisible();
  await expect(page.locator('[data-testid^="container-"]')).toHaveCount(2);
  await expect(page.getByText('Customers', { exact: true })).toBeVisible();
  await expect(page.getByText('Addresses', { exact: true })).toBeVisible();
});
