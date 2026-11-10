import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { saveDsl } from './save-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run the demo seed (python -m canvas_api.jobs.seed_demo) and export it first');

/**
 * canvas-vvi: live editing. Two people edit one diagram in two browsers and each sees the other's changes as
 * they're made; one Save saves for both; someone who can only view watches; leaving while someone else is
 * still editing doesn't lose the changes.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const PASSWORD = 'Harbor-violet-copper-58'; // gitleaks:allow
const EDITOR_NAME = `E2E Live Editor ${RUN}`;
const VIEWER_NAME = `E2E Live Viewer ${RUN}`;

let adminCtx: BrowserContext;
let admin: Page;
let editorCtx: BrowserContext;
let editor: Page;
let viewerCtx: BrowserContext;
let viewer: Page;
let diagramId = '';

const nodes = (page: Page) => page.locator('[data-testid="canvas-surface"] [data-testid^="node-"]');

async function open(page: Page) {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/** A new person, signed in in their own browser. */
async function person(browser: Browser, name: string, role: 'architect' | 'viewer'): Promise<{ ctx: BrowserContext; id: string }> {
  const email = `e2e-user-${RUN}-${role}@example.com`;
  const user = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name, role } });
  expect(user.status()).toBe(201);
  const body = await user.json();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  expect((await ctx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email, password: body.temporaryPassword } })).status()).toBe(200);
  expect(
    (await ctx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status(),
  ).toBe(200);
  return { ctx, id: body.user.id };
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill('admin@example.com');
  await admin.getByTestId('login-password').fill('admin-dev-password');
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  const created = await admin.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: { name: `Live editing ${RUN}`, diagramTypeId: 'flowchart' },
  });
  expect(created.status()).toBe(201);
  diagramId = (await created.json()).diagram.id;
  expect((await saveDsl(admin.request, API_BASE_URL, diagramId, 'flowchart TD\n  a[Start]\n')).status()).toBe(200);

  const editorUser = await person(browser, EDITOR_NAME, 'architect');
  editorCtx = editorUser.ctx;
  const share = await admin.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, {
    data: { granteeUserId: editorUser.id, accessLevel: 'edit' },
  });
  expect(share.status()).toBe(201);
  editor = await editorCtx.newPage();
  viewerCtx = (await person(browser, VIEWER_NAME, 'viewer')).ctx;
  viewer = await viewerCtx.newPage();
});

test.afterAll(async () => {
  await viewerCtx?.close();
  await editorCtx?.close();
  await adminCtx?.close();
});

test('each sees the other is here, editing live', async () => {
  await open(admin);
  await open(editor);
  await expect(admin.getByTestId('presence-banner')).toContainText(`${EDITOR_NAME} is also editing this diagram with you`);
  await expect(admin.getByTestId('presence-banner')).toHaveAttribute('data-live', 'true');
  await expect(editor.getByTestId('presence-banner')).toContainText('anyone’s Save saves them for all');
});

test('a shape one person adds appears for the other before anyone saves', async () => {
  await admin.getByTestId('add-shape-rectangle').click();
  await expect(nodes(admin)).toHaveCount(2);
  await expect(nodes(editor)).toHaveCount(2);
  await editor.getByTestId('add-shape-circle').click();
  await expect(nodes(editor)).toHaveCount(3);
  await expect(nodes(admin)).toHaveCount(3);
  await expect(admin.getByTestId('save-status')).toHaveText('Unsaved changes');
});

test('a change applied from the DSL text reaches the other person too', async () => {
  const panel = editor.getByTestId('dsl-panel');
  const text = await panel.inputValue();
  await panel.fill(text.replace('a[Start]', 'a[Begin]'));
  await editor.getByTestId('apply-dsl').click();
  await expect(admin.getByTestId('canvas-surface')).toContainText('Begin');
  await expect(admin.getByTestId('dsl-panel')).toHaveValue(/a\[Begin\]/);
});

test('what one person selects is outlined for the other, with their name', async () => {
  const first = nodes(admin).first();
  const id = ((await first.getAttribute('data-testid')) ?? '').replace(/^node-/, '');
  await first.click();
  const outline = editor.getByTestId(`others-selection-${id}`);
  await expect(outline).toBeVisible();
  await expect(outline).not.toHaveAttribute('data-name', EDITOR_NAME);
  // Clicking the empty canvas clears the selection, for the other person too.
  await admin.getByTestId('canvas-surface').click({ position: { x: 5, y: 5 } });
  await expect(outline).toHaveCount(0);
});

test('one Save saves for both: no conflict, and "Saved" for each', async () => {
  await admin.getByTestId('save-diagram').click();
  await expect(admin.getByTestId('save-status')).toHaveText('Saved');
  await expect(editor.getByTestId('save-status')).toHaveText('Saved');
  // The other person saves next, from the version the first one made: no conflict.
  await editor.getByTestId('add-shape-rectangle').click();
  await expect(nodes(admin)).toHaveCount(4);
  await editor.getByTestId('save-diagram').click();
  await expect(editor.getByTestId('save-status')).toHaveText('Saved');
  await expect(editor.getByTestId('save-conflict')).toHaveCount(0);
  await expect(admin.getByTestId('save-status')).toHaveText('Saved');
});

test('someone who can only view watches changes as they happen', async () => {
  await open(viewer);
  await expect(viewer.getByTestId('read-only-badge')).toBeVisible();
  await expect(nodes(viewer)).toHaveCount(4);
  await expect(admin.getByTestId('presence-banner')).toContainText(`${VIEWER_NAME} is watching`);
  await admin.getByTestId('add-shape-circle').click();
  await expect(nodes(viewer)).toHaveCount(5);
});

test('leaving while someone else is still editing keeps the changes with them', async () => {
  await expect(nodes(editor)).toHaveCount(5);
  await editor.getByTestId('back-to-diagrams').click();
  await expect(editor.getByTestId('home-nav-confirm')).toContainText('Someone else is still editing it');
  await editor.getByTestId('confirm-home-nav').click();
  await expect(editor.getByTestId('diagram-canvas')).toHaveCount(0);
  // The unsaved circle is still in the session, for the admin and for anyone opening the diagram now.
  await open(editor);
  await expect(nodes(editor)).toHaveCount(5);
  await expect(editor.getByTestId('save-status')).toHaveText('Unsaved changes');
});
