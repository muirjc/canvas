import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { nextCode } from '../tests/e2e/totp-helper';

/**
 * Captures the screenshots used by docs/user-guide and docs/admin-guide into docs/images/.
 * Re-runnable: demo content is looked up by name and reused. Only seeded/demo data is shown;
 * throwaway accounts are named e2e-user-<timestamp>-docs-*@example.com.
 */
test.describe.configure({ mode: 'serial' });

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/images');
const API = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN = { email: 'admin@example.com', password: 'admin-dev-password' };
const RUN = Date.now();
const PASSWORD = 'Demo-harbour-violin-52'; // gitleaks:allow

const FLOW_DSL = `flowchart TD
  start([Order received]) --> check{In stock?}
  check -->|Yes| pack[Pack order]
  check -->|No| backorder[Back-order item]
  pack --> ship[Ship order]
  backorder --> ship
`;
const FLOW_DSL_V2 = `flowchart TD
  start([Order received]) --> check{In stock?}
  check -->|Yes| pack[Pack order]
  pack --> ship[Ship order]
`;
const ERD_DSL = `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ ORDER_LINE : contains
  CUSTOMER {
    string id PK
    string name
  }
  ORDER {
    string id PK
    string customer_id FK
  }
`;

let adminCtx: BrowserContext;
let admin: Page;
let projectId = '';
let flowId = '';

const shot = (page: Page, name: string, target?: Locator) =>
  (target ?? page).screenshot({ path: path.join(OUT, name) });

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

/** Removes table rows mentioning throwaway/test accounts from the page (display only) so the shot shows demo data. */
async function hideTestRows(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('tr').forEach((tr) => {
      if (/e2e-user-|E2E /.test(tr.textContent ?? '')) tr.remove();
    });
  });
}

async function api(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, data?: unknown) {
  const res = await admin.request[method](`${API}${url}`, data === undefined ? undefined : { data });
  return res;
}

async function ensureDiagram(name: string, diagramTypeId: string, dsl: string): Promise<string> {
  const list = (await (await api('get', `/projects/${projectId}/diagrams?query=${encodeURIComponent(name)}`)).json()).diagrams as { id: string; name: string }[];
  const existing = list.find((d) => d.name === name);
  const id = existing?.id ?? (await (await api('post', `/projects/${projectId}/diagrams`, { name, diagramTypeId })).json()).diagram.id;
  expect((await api('patch', `/diagrams/${id}`, { dslContent: dsl })).status()).toBe(200);
  return id as string;
}

async function openEditor(page: Page, id = flowId) {
  await page.goto(`/?diagramId=${id}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.locator('[data-testid^="node-"]').first()).toBeVisible();
}

async function throwawayUser(browser: Browser, suffix: string) {
  const email = `e2e-user-${RUN}-docs-${suffix}@example.com`;
  const res = await api('post', '/admin/users', { email, name: `Demo ${suffix}`, role: 'architect' });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { email, id: body.user.id as string, otp: body.temporaryPassword as string };
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  admin = await adminCtx.newPage();
  await signIn(admin, ADMIN.email, ADMIN.password);
  await expect(admin.getByTestId('sign-out')).toBeVisible();
  await api('patch', '/admin/ai-settings', { chatEnabled: true });

  const projects = (await (await api('get', '/projects')).json()).projects as { id: string; name: string }[];
  const name = 'Demo – Order process';
  projectId = projects.find((p) => p.name === name)?.id ?? (await (await api('post', '/projects', { name })).json()).project.id;
  flowId = await ensureDiagram('Order flow', 'flowchart', FLOW_DSL);
  await ensureDiagram('Order data', 'erd', ERD_DSL);
  // Version history needs more than one version.
  await api('patch', `/diagrams/${flowId}`, { dslContent: FLOW_DSL_V2 });
  await api('patch', `/diagrams/${flowId}`, { dslContent: FLOW_DSL });

  // Something in Deleted Diagrams.
  const deleted = (await (await api('get', '/admin/deleted-diagrams')).json()) as { diagrams?: { name: string }[] };
  if (!(deleted.diagrams ?? []).some((d) => d.name === 'Demo – Retired draft')) {
    const id = (await (await api('post', `/projects/${projectId}/diagrams`, { name: 'Demo – Retired draft', diagramTypeId: 'flowchart' })).json()).diagram.id;
    await api('delete', `/diagrams/${id}`);
  }
});

test.afterAll(async () => {
  await adminCtx?.close();
});

test('sign-in', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('login-email')).toBeVisible();
  await shot(page, 'sign-in.png');
  await ctx.close();
});

test('browse screens', async () => {
  await admin.goto('/');
  await expect(admin.getByTestId('projects-page-list')).toBeVisible();
  await shot(admin, 'projects.png');

  await admin.goto(`/?projectId=${projectId}`);
  await expect(admin.getByTestId('project-browser')).toBeVisible();
  await expect(admin.getByText('Order flow').first()).toBeVisible();
  await shot(admin, 'project.png');

  await admin.getByTestId('new-diagram').click();
  await expect(admin.getByTestId('diagram-type-flowchart')).toBeVisible();
  await shot(admin, 'new-diagram.png');
  await admin.keyboard.press('Escape');
});

test('editor', async () => {
  await openEditor(admin);
  await admin.getByTestId('rail-tab-dsl').click();
  await shot(admin, 'editor.png');

  await admin.getByTestId('rail-tab-issues').click();
  await shot(admin, 'editor-issues.png');

  await admin.getByTestId('rail-tab-history').click();
  await expect(admin.getByTestId('version-history')).toBeVisible();
  await shot(admin, 'version-history.png');
  // canvas-3fha: an earlier version open read-only.
  await admin.locator('[data-testid^="view-version-"]').last().click();
  await expect(admin.getByTestId('version-preview-bar')).toBeVisible();
  await shot(admin, 'version-preview.png');
  await admin.getByTestId('close-preview').click();

  await admin.getByTestId('export-menu-trigger').click();
  await expect(admin.getByTestId('export-menu-list')).toBeVisible();
  await shot(admin, 'export-menu.png');
  await admin.keyboard.press('Escape');

  await admin.getByTestId('open-share-dialog').click();
  // canvas-cyt: the people picker, with its list of matches showing.
  await admin.getByTestId('share-email').fill('Archi');
  await expect(admin.getByRole('option', { name: /architect@example\.com/ })).toBeVisible();
  await shot(admin, 'share-dialog.png');
  await admin.getByTestId('close-share-dialog').click();

  // Chat on a fresh scratch diagram (a diagram's chat history persists, so reusing one would grow
  // run after run); it is deleted again afterwards.
  const scratch = (await (await api('post', `/projects/${projectId}/diagrams`, { name: 'Order flow', diagramTypeId: 'flowchart' })).json()).diagram.id as string;
  expect((await api('patch', `/diagrams/${scratch}`, { dslContent: FLOW_DSL })).status()).toBe(200);
  await openEditor(admin, scratch);
  await admin.getByTestId('rail-tab-chat').click();
  const replies = admin.locator('[data-testid="chat-message-assistant"]');
  await admin.getByTestId('chat-input').fill('Add a shape called Review');
  await admin.getByTestId('chat-send').click();
  await expect(replies).toHaveCount(1);
  await expect(admin.locator('[data-testid^="chat-usage-"]').first()).toBeVisible();
  await expect(admin.getByTestId('chat-edits-applied')).toBeVisible();
  await shot(admin, 'editor-chat.png');
  await api('delete', `/diagrams/${scratch}`);
});

test('create with AI', async () => {
  await admin.goto(`/?projectId=${projectId}`);
  await admin.getByTestId('create-via-ai-chat').click();
  await admin.getByTestId('ai-create-name').fill('Demo – Draft from AI');
  await admin.getByTestId('ai-create-persona').selectOption({ label: 'Business Architect' });
  await admin.getByTestId('ai-create-description').fill('Create a diagram');
  await admin.getByTestId('ai-create-confirm').click();
  await expect(admin.getByTestId('create-chat-assistant').last()).toBeVisible();
  await shot(admin, 'create-with-ai.png');
  await admin.getByTestId('ai-create-cancel').click();
});

test('account: usage, two-step set-up and sign-in code', async ({ browser }) => {
  await admin.goto('/?account=password');
  await expect(admin.getByTestId('change-password-page')).toBeVisible();
  await expect(admin.getByTestId('my-ai-usage')).toBeVisible();
  await shot(admin, 'change-password.png');

  // A throwaway account for the MFA screens.
  const user = await throwawayUser(browser, 'mfa');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  expect((await ctx.request.post(`${API}/auth/local/login`, { data: { email: user.email, password: user.otp } })).status()).toBe(200);
  expect((await ctx.request.post(`${API}/auth/password`, { data: { currentPassword: user.otp, newPassword: PASSWORD } })).status()).toBe(200);
  const page = await ctx.newPage();
  await page.goto('/?account=password');
  await page.getByTestId('mfa-begin').click();
  await expect(page.getByTestId('mfa-qr')).toBeVisible();
  const secret = ((await page.getByTestId('mfa-secret').textContent()) ?? '').replace(/\s+/g, '');
  await shot(page, 'mfa-setup.png', page.getByTestId('mfa-setup-page'));

  const { code } = await nextCode(secret, 0);
  await page.getByTestId('mfa-confirm-code').fill(code);
  await page.getByTestId('mfa-confirm-submit').click();
  await expect(page.getByTestId('mfa-recovery-codes')).toBeVisible();
  await page.getByTestId('mfa-recovery-saved').check();
  await page.getByTestId('mfa-done').click();
  await page.getByTestId('sign-out').click();
  await signIn(page, user.email, PASSWORD);
  await expect(page.getByTestId('mfa-code')).toBeVisible();
 
  await shot(page, 'mfa-code.png');
  await ctx.close();
});

test("admin screens", async () => {
  await admin.goto('/?admin=overview');
  await expect(admin.getByTestId('admin-shell')).toBeVisible();
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'admin-overview.png');

  await admin.goto('/?admin=users');
  await expect(admin.getByTestId('users-add')).toBeVisible();
  await admin.waitForLoadState('networkidle');
  await hideTestRows(admin);
  await shot(admin, 'admin-users.png');
  // The hidden rows were removed from React's DOM; reload before interacting again.
  await admin.goto('/?admin=users');
  await expect(admin.getByTestId('users-add')).toBeVisible();

  await admin.getByTestId('users-add').click();
  await admin.getByTestId('add-user-email').fill('alex.morgan@example.com');
  await admin.getByTestId('add-user-name').fill('Alex Morgan');
  await admin.getByTestId('add-user-role').selectOption('architect');
  await shot(admin, 'admin-add-user.png');
  await admin.keyboard.press('Escape');

  // Create a throwaway user through the dialog to capture the one-time password, then its delete dialog.
  const email = `e2e-user-${RUN}-docs-otp@example.com`;
  await admin.getByTestId('users-add').click();
  await admin.getByTestId('add-user-email').fill(email);
  await admin.getByTestId('add-user-name').fill('Alex Morgan');
  await admin.getByTestId('add-user-role').selectOption('architect');
  await admin.getByTestId('add-user-submit').click();
  await expect(admin.getByTestId('one-time-password')).toBeVisible();
  await shot(admin, 'admin-one-time-password.png');
  await admin.getByTestId('one-time-password-done').click();
  const row = admin.locator('tr', { hasText: email });
  await expect(row).toBeVisible();
  await row.locator('[data-testid^="delete-user-"]').click();
  await expect(admin.getByTestId('delete-user-dialog')).toBeVisible();
  await expect(admin.getByTestId('confirm-delete-user')).toBeEnabled();
  await shot(admin, 'admin-delete-user.png');
  await admin.getByTestId('confirm-delete-user').click();
  await expect(admin.getByTestId('delete-user-status')).toBeVisible();

  await admin.goto('/?admin=standards');
  await expect(admin.getByTestId('standard-new')).toBeVisible();
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'admin-standards.png');
  await admin.getByTestId('standard-view-active').click();
  await expect(admin.getByTestId('standard-form')).toBeVisible();
  await admin.getByTestId('standard-view-edit').click();
  await expect(admin.getByTestId('standard-revise-banner')).toBeVisible();
  await shot(admin, 'admin-standard-editor.png');

  await admin.goto('/?admin=ai-personas');
  await expect(admin.getByTestId('persona-create-submit')).toBeVisible();
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'admin-personas.png');

  // A price for the mock model, so the page shows a cost (removed again afterwards).
  await api('put', '/admin/ai-prices', { provider: 'mock-provider', modelId: 'mock-model-id', inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 });
  await admin.goto('/?admin=ai-usage');
  await expect(admin.getByTestId('ai-usage-table')).toBeVisible();
  await expect(admin.getByTestId('ai-price-table')).toBeVisible();
  await shot(admin, 'admin-ai-usage.png');
  const prices = admin.getByTestId('ai-prices');
  await prices.scrollIntoViewIfNeeded();
  await shot(admin, 'admin-model-prices.png', prices);
  await admin.request.delete(`${API}/admin/ai-prices`, { params: { provider: 'mock-provider', modelId: 'mock-model-id' } });

  await admin.goto('/?admin=audit');
  await expect(admin.getByTestId('audit-log')).toBeVisible();
  await hideTestRows(admin);
  await shot(admin, 'admin-audit-log.png');

  await admin.goto('/?admin=deleted');
  await admin.waitForLoadState('networkidle');
  // Only the demo draft, not whatever test runs left behind.
  await admin.getByRole('searchbox').or(admin.getByPlaceholder(/Search by name/)).first().fill('Retired draft');
  await expect(admin.getByText('Demo – Retired draft')).toBeVisible();
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'admin-deleted-diagrams.png');
});

// canvas-3s5.4: the GitHub approval screens. They need
// the local API configured with a GitHub App and the "GitHub live test" project from the live check
// (its Sample Order Flow has real pull-request history); they only read, never submit.
test('github approval', async () => {
  const status = await (await api('get', '/admin/github/status')).json();
  const projects = (await (await api('get', '/projects')).json()).projects as { id: string; name: string }[];
  const live = projects.find((p) => p.name === 'GitHub live test');
  test.skip(!status.enabled || !live, 'needs a configured GitHub App and the "GitHub live test" project');
  const diagrams = (await (await api('get', `/projects/${live!.id}/diagrams?query=Sample`)).json()).diagrams as { id: string; name: string }[];
  const sample = diagrams.find((d) => d.name === 'Sample Order Flow');
  test.skip(!sample, 'needs the Sample Order Flow diagram');

  await admin.goto('/?admin=github');
  await expect(admin.getByTestId('github-connected')).toBeVisible();
  await expect(admin.getByTestId('github-links')).toBeVisible();
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'admin-github.png');

  await admin.goto(`/?diagramId=${sample!.id}`);
  await expect(admin.getByTestId('diagram-canvas')).toBeVisible();
  await expect(admin.getByTestId('submission-chip')).toBeVisible();
  await admin.getByTestId('rail-tab-approval').click();
  await expect(admin.getByTestId('approval-history')).toBeVisible();
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'editor-approval.png');
});

// canvas-3dq: the Libraries admin page.
test('libraries', async () => {
  await admin.goto('/?admin=libraries');
  await expect(admin.getByTestId('libraries-table')).toBeVisible();
  // Only the built-in libraries, not whatever test runs left behind.
  await admin.evaluate(() => {
    document.querySelectorAll('[data-testid^="library-row-"]').forEach((tr) => {
      if (!tr.querySelector('[data-testid^="library-origin-"]')?.textContent?.includes('Built-in')) tr.remove();
    });
  });
  await admin.waitForLoadState('networkidle');
  await shot(admin, 'admin-libraries.png');
});
