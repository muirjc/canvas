import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-7vs.1: sequence diagrams previously rendered through the exact same flat-row,
 * generic-flowchart code path — every message between the same two participants rendered fully
 * coincident. This file exercises the real, computed lifeline/timeline layout end to end (real
 * geometry relationships, not just "it doesn't throw" — quickstart.md's own warning). Follows
 * auto-layout.spec.ts's per-test-isolation pattern (API-created project/diagram, not the
 * "new-diagram" UI dialog).
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

async function createDiagram(page: Page, projectId: string, name: string, initialDslContent: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name, diagramTypeId: 'sequence', initialDslContent },
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

async function lifelineX(page: Page, nodeId: string): Promise<number> {
  const line = page.locator(`[data-testid="node-${nodeId}"] line`).first();
  const value = await line.getAttribute('x1');
  if (value === null) throw new Error(`no lifeline found for ${nodeId}`);
  return Number(value);
}

async function messageY(page: Page, edgeId: string): Promise<number> {
  const line = page.locator(`[data-testid="edge-${edgeId}"] line`).first();
  const value = await line.getAttribute('y1');
  if (value === null) throw new Error(`no message line found for ${edgeId}`);
  return Number(value);
}

const ALICE_JOHN_DSL = [
  'sequenceDiagram',
  'participant Alice',
  'participant John',
  'Alice->>+John: msg1',
  'John-->>Alice: msg2',
  'Alice->>+John: msg3',
  'John-->>-Alice: msg4',
  '',
].join('\n');

test('participants render as distinct, left-to-right ordered lifelines', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Lifelines ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'sequenceDiagram\nparticipant Alice\nparticipant Bob\nparticipant Carol\n');
  await openDiagram(page, projectId, diagramId);

  const aliceX = await lifelineX(page, 'Alice');
  const bobX = await lifelineX(page, 'Bob');
  const carolX = await lifelineX(page, 'Carol');
  expect(aliceX).toBeLessThan(bobX);
  expect(bobX).toBeLessThan(carolX);
});

test('the confirmed bug-report shape (4 messages, same 2 participants) renders 4 distinct, ordered message lines — not coincident', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Messages ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, ALICE_JOHN_DSL);
  await openDiagram(page, projectId, diagramId);

  const ys = await Promise.all(['e1', 'e2', 'e3', 'e4'].map((id) => messageY(page, id)));
  expect(new Set(ys).size).toBe(4);
  expect(ys[0]).toBeLessThan(ys[1]);
  expect(ys[1]).toBeLessThan(ys[2]);
  expect(ys[2]).toBeLessThan(ys[3]);
});

test('a self-message renders as a loop path, not a zero-length line', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Self Message ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'sequenceDiagram\nparticipant A\nA->>A: think\n');
  await openDiagram(page, projectId, diagramId);

  await expect(page.locator('[data-testid="edge-e1"] path')).toHaveCount(1);
  await expect(page.locator('[data-testid="edge-e1"] line')).toHaveCount(0);
});

test('an activate/deactivate pair renders a bar on the correct participant', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Activation ${Date.now()}`;
  const projectId = await createProject(page, name);
  const dsl = 'sequenceDiagram\nparticipant A\nparticipant B\nactivate B\nA->>B: work\ndeactivate B\n';
  const diagramId = await createDiagram(page, projectId, name, dsl);
  await openDiagram(page, projectId, diagramId);

  const bar = page.locator('[data-testid^="container-pt"]').first();
  await expect(bar).toBeVisible();
  const barX = Number(await bar.getAttribute('x'));
  const bX = await lifelineX(page, 'B');
  // The bar is centered on B's lifeline (its own x is offset left by half its width).
  expect(Math.abs(barX + 5 - bX)).toBeLessThan(1);
});

test('a loop block renders spanning only its referenced participants\' lifelines', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Loop Bounds ${Date.now()}`;
  const projectId = await createProject(page, name);
  const dsl = 'sequenceDiagram\nparticipant Alice\nparticipant Bob\nparticipant Carol\nloop Retry\nAlice->>Bob: ping\nBob->>Alice: pong\nend\n';
  const diagramId = await createDiagram(page, projectId, name, dsl);
  await openDiagram(page, projectId, diagramId);

  await expect(page.locator('[data-testid^="container-block"]')).toContainText('loop Retry');
  // canvas-7vs.8: the block now also draws a small corner-tab <rect> behind its label — the
  // outer bounding box is always the FIRST <rect> in the group.
  const blockRect = page.locator('[data-testid^="container-block"] rect').first();
  // Raw SVG attributes (local coordinate space), not boundingBox() (page-absolute pixels) — must
  // stay consistent with how lifelineX() reads Carol's own lifeline, or the two numbers being
  // compared are in different coordinate spaces and differ by the SVG element's own page offset.
  const blockX = Number(await blockRect.getAttribute('x'));
  const blockWidth = Number(await blockRect.getAttribute('width'));
  const carolX = await lifelineX(page, 'Carol');
  expect(blockX + blockWidth).toBeLessThan(carolX);
});

test('a Note right of renders beside its participant\'s lifeline', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Note Position ${Date.now()}`;
  const projectId = await createProject(page, name);
  const dsl = 'sequenceDiagram\nparticipant Bob\nNote right of Bob: hello\n';
  const diagramId = await createDiagram(page, projectId, name, dsl);
  await openDiagram(page, projectId, diagramId);

  const noteRect = page.locator('[data-testid^="container-note"] rect');
  const noteX = Number(await noteRect.getAttribute('x'));
  const bobX = await lifelineX(page, 'Bob');
  expect(noteX).toBeGreaterThan(bobX);
});

test('a Note gets a pale-yellow fill and a visible connector line to its participant (canvas-7vs.8/.9)', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Note Style ${Date.now()}`;
  const projectId = await createProject(page, name);
  const dsl = 'sequenceDiagram\nparticipant Bob\nNote right of Bob: hello\n';
  const diagramId = await createDiagram(page, projectId, name, dsl);
  await openDiagram(page, projectId, diagramId);

  const container = page.locator('[data-testid^="container-note"]');
  await expect(container.locator('rect')).toHaveAttribute('fill', '#fff9c4');
  await expect(container.locator('line')).toHaveCount(1);
});

test('a box grouping renders with its own finer dash, distinct from a control-flow block', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Box Style ${Date.now()}`;
  const projectId = await createProject(page, name);
  const dsl = 'sequenceDiagram\nbox Team\nparticipant A\nparticipant B\nend\n';
  const diagramId = await createDiagram(page, projectId, name, dsl);
  await openDiagram(page, projectId, diagramId);

  const boxRect = page.locator('[data-testid^="container-box"] rect');
  await expect(boxRect).toHaveAttribute('stroke-dasharray', '2,3');
});

test('a sequence diagram has no "Add Shape" toolbar at all (canvas-7vs.10)', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence No Shapes Toolbar ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'sequenceDiagram\nparticipant Alice\n');
  await openDiagram(page, projectId, diagramId);

  await expect(page.locator('[data-testid^="add-shape-"]')).toHaveCount(0);
});

test('dragging a sequence participant does not move it (computed-only layout, FR-013)', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Sequence Drag Disabled ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'sequenceDiagram\nparticipant Alice\nparticipant Bob\n');
  await openDiagram(page, projectId, diagramId);

  const before = await lifelineX(page, 'Alice');
  const locator = page.locator('[data-testid="node-Alice"] rect').first();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('no bounding box for Alice');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 80, { steps: 6 });
  await page.mouse.up();

  const after = await lifelineX(page, 'Alice');
  expect(after).toBe(before);
});
