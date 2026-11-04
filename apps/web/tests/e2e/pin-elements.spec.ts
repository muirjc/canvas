import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run the demo seed and export it first');

/** canvas-rqm6: Pin keeps a shape in place when Auto Layout runs. */

const DSL = ['flowchart TD', '  A[Start] --> B[Middle]', '  B --> C[End]', ''].join('\n');

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-email').fill('admin@example.com');
  await page.getByTestId('login-password').fill('admin-dev-password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

function positionOf(source: string, id: string): { x: number; y: number } {
  const match = source.match(new RegExp(`${id}:\\s*\\n\\s*x:\\s*(-?[0-9.]+)\\s*\\n\\s*y:\\s*(-?[0-9.]+)`));
  if (!match) throw new Error(`no position for "${id}" in DSL:\n${source}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

test('a pinned shape stays put under Auto Layout, and unpinning lets it move', async ({ page }) => {
  await signIn(page);
  const name = `Pin ${Date.now()}`;
  const created = await page.request.post(`${API_BASE_URL}/projects`, { data: { name } });
  const projectId = (await created.json()).project.id;
  const diagram = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name, diagramTypeId: 'flowchart', initialDslContent: DSL },
  });
  const diagramId = (await diagram.json()).diagram.id;
  await page.goto(`/?projectId=${projectId}`);
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await expect(page.getByTestId('pin-toggle')).toBeDisabled();
  await page.getByTestId('node-B').click();
  await expect(page.getByTestId('pin-toggle')).toHaveText(/Pin/);
  await page.getByTestId('pin-toggle').click();
  await expect(page.getByTestId('pin-badge-B')).toBeVisible();
  await expect(page.getByTestId('pin-toggle')).toHaveText(/Unpin/);
  expect(await dsl(page)).toMatch(/pinned:\s*\n\s*- B/);

  // Move B somewhere unlike any layout, then run Auto Layout.
  const box = (await page.getByTestId('node-B').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 120, { steps: 8 });
  await page.mouse.up();
  const before = await dsl(page);
  const bBefore = positionOf(before, 'B');
  const aBefore = positionOf(before, 'A');

  await page.getByTestId('auto-layout').click();
  const after = await dsl(page);
  expect(positionOf(after, 'B')).toEqual(bBefore);
  expect(positionOf(after, 'A')).not.toEqual(aBefore);

  // Unpin: the badge and the front-matter entry go away.
  await page.getByTestId('node-B').click();
  await page.getByTestId('pin-toggle').click();
  await expect(page.getByTestId('pin-badge-B')).toHaveCount(0);
  expect(await dsl(page)).not.toMatch(/pinned:/);
});
