import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { saveDsl } from './save-helpers';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * canvas-2h2w.1: everyone signed in can read every project and diagram (open read-only). A user
 * with no grant sees someone else's project under "All projects", can open it and its diagrams,
 * and gets no way to change anything: no New Diagram, Move or Delete, no Save, no editing tools,
 * no AI chat, and a read-only DSL tab.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const PASSWORD = 'Meadow-cobalt-ember-73'; // gitleaks:allow
const PROJECT_NAME = `Open read ${RUN}`;

let adminCtx: BrowserContext;
let readerCtx: BrowserContext;
let reader: Page;
let projectId = '';
let diagramId = '';

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill('admin@example.com');
  await admin.getByTestId('login-password').fill('admin-dev-password');
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  projectId = (await (await admin.request.post(`${API_BASE_URL}/projects`, { data: { name: PROJECT_NAME } })).json()).project.id;
  const created = await admin.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name: `Readable ${RUN}`, diagramTypeId: 'flowchart' },
  });
  diagramId = (await created.json()).diagram.id;
  expect((await saveDsl(admin.request, API_BASE_URL, diagramId, 'flowchart TD\n  a[Alpha] --> b[Beta]\n')).status()).toBe(200);

  const email = `e2e-user-${RUN}-reader@example.com`;
  const user = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name: `E2E Reader ${RUN}`, role: 'architect' } });
  expect(user.status()).toBe(201);
  const body = await user.json();
  readerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  expect((await readerCtx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email, password: body.temporaryPassword } })).status()).toBe(200);
  expect(
    (await readerCtx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status(),
  ).toBe(200);
  reader = await readerCtx.newPage();
});

test.afterAll(async () => {
  await readerCtx?.close();
  await adminCtx?.close();
});

test("someone else's project is listed under All projects and opens read-only", async () => {
  await reader.goto('/');
  await reader.getByTestId('projects-page-filter').fill(PROJECT_NAME);
  const row = reader.getByTestId(`projects-page-row-${projectId}`);
  await expect(reader.getByTestId('projects-page-all-list').getByTestId(`projects-page-row-${projectId}`)).toBeVisible();
  await expect(row.getByTestId(`projects-page-rename-${projectId}`)).toHaveCount(0);

  await reader.getByTestId(`projects-page-open-${projectId}`).click();
  await expect(reader.getByTestId('project-read-only-note')).toBeVisible();
  await expect(reader.getByTestId('new-diagram')).toHaveCount(0);
  await expect(reader.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  await expect(reader.getByTestId(`move-diagram-${diagramId}`)).toHaveCount(0);
  await expect(reader.getByTestId(`delete-diagram-${diagramId}`)).toHaveCount(0);
});

test('the diagram opens with no way to change it', async () => {
  await reader.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(reader.getByTestId('diagram-canvas')).toBeVisible();
  await expect(reader.locator('[data-testid="canvas-surface"] [data-testid^="node-"]')).toHaveCount(2);

  await expect(reader.getByTestId('read-only-badge')).toHaveText('Read-only');
  await expect(reader.getByTestId('save-diagram')).toHaveCount(0);
  await expect(reader.getByTestId('read-only-tools-note')).toBeVisible();
  await expect(reader.getByTestId('add-shape-rectangle')).toBeHidden();
  await expect(reader.getByTestId('rail-tab-chat')).toHaveCount(0);
  await expect(reader.getByTestId('dsl-panel')).toHaveAttribute('readonly', '');
  await expect(reader.getByTestId('apply-dsl')).toHaveCount(0);

  // Selecting a shape shows no edit buttons, and Delete does nothing.
  await reader.getByTestId('node-a').click();
  await expect(reader.locator('.canvas-edit-affordance:visible')).toHaveCount(0);
  await reader.keyboard.press('Delete');
  await expect(reader.locator('[data-testid="canvas-surface"] [data-testid^="node-"]')).toHaveCount(2);
  await expect(reader.getByTestId('save-status')).toHaveText('Saved');

  // Comments are readable, but View can't post.
  await reader.getByTestId('rail-tab-comments').click();
  await expect(reader.getByTestId('comment-new-submit')).toHaveCount(0);
});
