import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-esn: dagre-based "Auto Layout" for flowchart-family diagrams (Canvas.tsx's `Tools`
 * section, gated by `dslFamily === 'flowchart'`, the same scoping `getAddableShapes` already
 * uses). Per-test isolation via `page.request.post`, mirroring `diagram-rename.spec.ts`/
 * `project-rename-move.spec.ts` rather than a shared fixture. Pure-function behavior (dagre
 * ranking, container-relative-position preservation, edge cases) is covered directly against
 * `autoLayout` in `packages/diagram-core/tests/contract/auto-layout.test.ts` — this file only
 * exercises the toolbar wiring, DSL round-trip, and server-side persistence.
 */

const OVERLAPPING_DSL = [
  'flowchart TD',
  '  A[Start] --> B{Decision}',
  '  B -->|Yes| C[One]',
  '  B -->|No| D[Two]',
  '  C --> E[Merge]',
  '  D --> E',
  '',
].join('\n');

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

async function createDiagram(
  page: Page,
  projectId: string,
  name: string,
  diagramTypeId: string,
  initialDslContent?: string,
): Promise<string> {
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

/** Reads the DSL panel — the canonical representation (mirrors containers.spec.ts's `dsl()`). */
async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

/** Position of a node from the DSL's YAML front-matter (mirrors containers.spec.ts /
 *  ai-edit-diagram.spec.ts's own `positionOf`/`extractPosition`). */
function positionOf(source: string, id: string): { x: number; y: number } {
  const match = source.match(new RegExp(`${id}:\\s*\\n\\s*x:\\s*(-?[0-9.]+)\\s*\\n\\s*y:\\s*(-?[0-9.]+)`));
  if (!match) throw new Error(`no position for "${id}" in DSL:\n${source}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

test('a flowchart diagram shows the Auto Layout button and direction picker', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Auto Layout Visible ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'flowchart', 'flowchart TD\n  A[Start]\n');
  await openDiagram(page, projectId, diagramId);

  await expect(page.getByTestId('auto-layout')).toBeVisible();
  await expect(page.getByTestId('auto-layout-direction')).toBeVisible();
});

test('a non-flowchart-family diagram (sequence) does not show Auto Layout at all', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Auto Layout Hidden ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'sequence');
  await openDiagram(page, projectId, diagramId);

  await expect(page.getByTestId('auto-layout')).toHaveCount(0);
  await expect(page.getByTestId('auto-layout-direction')).toHaveCount(0);
});

test('clicking Auto Layout rearranges nodes off their default single-row grid positions', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Auto Layout Rearrange ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'flowchart', OVERLAPPING_DSL);
  await openDiagram(page, projectId, diagramId);

  // No front-matter positions were supplied, so the parser's default auto-position grid places
  // every one of these five nodes in the same row (same y, evenly spaced x) — confirm that
  // premise before asserting Auto Layout changes it.
  const before = await dsl(page);
  const aBefore = positionOf(before, 'A');
  const bBefore = positionOf(before, 'B');
  expect(aBefore.y).toBe(bBefore.y);

  await page.getByTestId('auto-layout').click();

  const after = await dsl(page);
  const a = positionOf(after, 'A');
  const b = positionOf(after, 'B');
  const c = positionOf(after, 'C');
  const d = positionOf(after, 'D');
  const e = positionOf(after, 'E');

  // TD ranking: A is the sole root, B is its only child, C/D share a rank below B (the
  // diamond's two branches), and E (their common sink) is below both.
  expect(b.y).toBeGreaterThan(a.y);
  expect(c.y).toBeGreaterThan(b.y);
  expect(d.y).toBeGreaterThan(b.y);
  expect(e.y).toBeGreaterThan(c.y);
  expect(e.y).toBeGreaterThan(d.y);
  expect(c.y).toBeCloseTo(d.y, 0);
  expect(c.x).not.toBeCloseTo(d.x, 0);
});

test('switching direction to LR and re-running Auto Layout updates the DSL header token', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Auto Layout Direction ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'flowchart', OVERLAPPING_DSL);
  await openDiagram(page, projectId, diagramId);

  await expect(page.getByTestId('dsl-panel')).toContainText('flowchart TD');

  await page.getByTestId('auto-layout-direction').selectOption('LR');
  await page.getByTestId('auto-layout').click();

  const after = await dsl(page);
  expect(after).toContain('flowchart LR');
  expect(after).not.toMatch(/^flowchart TD/m);

  // Direction actually drove the ranking axis this time — B is to the right of A, not below it.
  const a = positionOf(after, 'A');
  const b = positionOf(after, 'B');
  expect(b.x).toBeGreaterThan(a.x);
});

test('Auto Layout + Save persists the new direction and positions server-side', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Auto Layout Persist ${Date.now()}`;
  const projectId = await createProject(page, name);
  const diagramId = await createDiagram(page, projectId, name, 'flowchart', OVERLAPPING_DSL);
  await openDiagram(page, projectId, diagramId);

  await page.getByTestId('auto-layout-direction').selectOption('LR');
  await page.getByTestId('auto-layout').click();

  const clientDsl = await dsl(page);
  const clientA = positionOf(clientDsl, 'A');
  const clientB = positionOf(clientDsl, 'B');

  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  // A fresh server-side GET, not page.reload() — reload does not deep-link back into an open
  // diagram in this app (a pre-existing, unrelated navigation quirk, confirmed during manual
  // verification of this feature — not something to work around here).
  const getResponse = await page.request.get(`${API_BASE_URL}/diagrams/${diagramId}`);
  expect(getResponse.status()).toBe(200);
  const persistedDsl: string = (await getResponse.json()).diagram.dslContent;

  expect(persistedDsl).toContain('flowchart LR');
  const serverA = positionOf(persistedDsl, 'A');
  const serverB = positionOf(persistedDsl, 'B');
  expect(serverA).toEqual(clientA);
  expect(serverB).toEqual(clientB);
});
