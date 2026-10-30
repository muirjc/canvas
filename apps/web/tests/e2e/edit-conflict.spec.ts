import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { saveDsl } from './save-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-obp0: two people editing one diagram. The second Save is refused and explained, with
 * "Save mine anyway" and "Load the newer version"; and each editor is told who else has it open.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const PASSWORD = 'Harbor-violet-copper-58'; // gitleaks:allow
const EDITOR_NAME = `E2E Editor ${RUN}`;

let adminCtx: BrowserContext;
let admin: Page;
let editorCtx: BrowserContext;
let editor: Page;
let diagramId = '';

const nodes = (page: Page) => page.locator('[data-testid="canvas-surface"] [data-testid^="node-"]');

async function open(page: Page) {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function addShapeAndSave(page: Page) {
  await page.getByTestId('add-shape-rectangle').click();
  await page.getByTestId('save-diagram').click();
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
    data: { name: `Edit conflict ${RUN}`, diagramTypeId: 'flowchart' },
  });
  expect(created.status()).toBe(201);
  diagramId = (await created.json()).diagram.id;
  expect((await saveDsl(admin.request, API_BASE_URL, diagramId, 'flowchart TD\n  a[Start]\n')).status()).toBe(200);

  const email = `e2e-user-${RUN}-editor@example.com`;
  const user = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name: EDITOR_NAME, role: 'architect' } });
  expect(user.status()).toBe(201);
  const body = await user.json();
  const share = await admin.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, {
    data: { granteeUserId: body.user.id, accessLevel: 'edit' },
  });
  expect(share.status()).toBe(201);
  editorCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  expect((await editorCtx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email, password: body.temporaryPassword } })).status()).toBe(200);
  expect(
    (await editorCtx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status(),
  ).toBe(200);
  editor = await editorCtx.newPage();
});

test.afterAll(async () => {
  await editorCtx?.close();
  await adminCtx?.close();
});

test('each editor is told who else has the diagram open', async () => {
  // Wait for the editor's first heartbeat to land, so the admin's first one hears about it.
  const heartbeat = editor.waitForResponse((r) => r.url().includes('/presence') && r.request().method() === 'PUT');
  await open(editor);
  await heartbeat;
  await expect(editor.getByTestId('presence-banner')).toHaveCount(0);
  await open(admin);
  // The admin's first heartbeat already hears about the editor.
  await expect(admin.getByTestId('presence-banner')).toContainText(`${EDITOR_NAME} is also editing this diagram`);
});

test('a save on top of a newer one is refused; "Save mine anyway" keeps both in History', async () => {
  // Both have the same version open. The admin saves first.
  await addShapeAndSave(admin);
  await expect(admin.getByTestId('save-status')).toHaveText('Saved');

  await addShapeAndSave(editor);
  await expect(editor.getByTestId('save-conflict')).toBeVisible();
  await expect(editor.getByTestId('save-conflict-message')).toContainText('saved a newer version');
  await expect(editor.getByTestId('save-status')).toHaveText('Unsaved changes');

  await editor.getByTestId('save-conflict-save-mine').click();
  await expect(editor.getByTestId('save-conflict')).toHaveCount(0);
  await expect(editor.getByTestId('save-status')).toHaveText('Saved');

  // v1 empty, v2 seeded, v3 the admin's, v4 the editor's: nothing was lost.
  await editor.getByTestId('rail-tab-history').click();
  await expect(editor.getByTestId('version-4')).toBeVisible();
  await expect(editor.getByTestId('version-3')).toBeVisible();
});

test('"Load the newer version" replaces the canvas with what was saved', async () => {
  // The admin's editor is still on v3; the editor's v4 has two shapes.
  await admin.getByTestId('add-shape-circle').click();
  await admin.getByTestId('save-diagram').click();
  await expect(admin.getByTestId('save-conflict')).toBeVisible();
  await expect(admin.getByTestId('save-conflict-message')).toContainText(EDITOR_NAME);
  await expect(admin.getByTestId('save-conflict-download')).toHaveAttribute('download', /my-version\.mmd$/);

  await admin.getByTestId('save-conflict-load').click();
  await expect(admin.getByTestId('save-conflict')).toHaveCount(0);
  await expect(admin.getByTestId('save-status')).toHaveText('Saved');
  await expect(nodes(admin)).toHaveCount(2); // Start + the editor's rectangle; the admin's circle is gone

  // And a save from there goes through: the admin is now on the newest version.
  await addShapeAndSave(admin);
  await expect(admin.getByTestId('save-status')).toHaveText('Saved');
});

test('once the other editor leaves, the banner goes', async () => {
  await editor.goto('/');
  await expect(editor.getByTestId('diagram-canvas')).toHaveCount(0);
  await admin.reload();
  await expect(admin.getByTestId('diagram-canvas')).toBeVisible();
  await expect(admin.getByTestId('presence-banner')).toHaveCount(0);
});
