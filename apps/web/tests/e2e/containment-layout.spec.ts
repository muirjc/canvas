import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-m0g: live-reported against the real bank-boundary C4 example — parentContainerId chains
 * parsed correctly, but every container/node came from one flat, containment-blind auto-position
 * counter, so a container's rendered box never actually enclosed its children. Confirms the fix
 * end to end in the real interactive canvas (not just the parser-level contract tests), following
 * sequence-rendering.spec.ts's own per-test-isolation pattern.
 */

async function signIn(page: Page, email: string, password: string, url = '/'): Promise<void> {
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

async function createDiagram(page: Page, projectId: string, name: string, diagramTypeId: string, initialDslContent: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name, diagramTypeId, initialDslContent },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).diagram.id;
}

async function openDiagram(page: Page, projectId: string, diagramId: string): Promise<void> {
  await page.goto(`/?projectId=${projectId}`);
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function containerBox(page: Page, containerId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = page.locator(`[data-testid="container-${containerId}"] rect`).first();
  const [x, y, width, height] = await Promise.all([
    rect.getAttribute('x'),
    rect.getAttribute('y'),
    rect.getAttribute('width'),
    rect.getAttribute('height'),
  ]);
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

function encloses(parent: { x: number; y: number; width: number; height: number }, child: { x: number; y: number; width: number; height: number }): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height
  );
}

const BANK_BOUNDARY_DSL = [
  'C4Context',
  'Person(customer, "Customer")',
  'Enterprise_Boundary(b0, "BankBoundary0") {',
  '  System(banking_system, "Internet Banking System")',
  '  System_Boundary(b1, "BankBoundary") {',
  '    SystemDb(banking_system_db, "Mainframe Banking System")',
  '    System_Boundary(b2, "BankBoundary2") {',
  '      System(banking_system2, "Banking System 2")',
  '    }',
  '    System_Boundary(b3, "BankBoundary3") {',
  '      SystemQueue(banking_system_queue, "Banking System Queue")',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

test('a freshly-imported C4 diagram with nested boundaries renders each container actually enclosing its children', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Bank Boundary Nesting ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'c4-context', BANK_BOUNDARY_DSL);
  await openDiagram(page, projectId, diagramId);

  const b0 = await containerBox(page, 'b0');
  const b1 = await containerBox(page, 'b1');
  const b2 = await containerBox(page, 'b2');
  const b3 = await containerBox(page, 'b3');

  expect(encloses(b0, b1)).toBe(true);
  expect(encloses(b1, b2)).toBe(true);
  expect(encloses(b1, b3)).toBe(true);
  // Transitively: b2/b3 are also within the outermost b0, not just their direct parent b1.
  expect(encloses(b0, b2)).toBe(true);
  expect(encloses(b0, b3)).toBe(true);
});
