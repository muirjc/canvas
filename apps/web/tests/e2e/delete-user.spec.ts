import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-0se: an admin deletes a user from the Users page. Their projects and diagrams go to a
 * chosen user, the row disappears, and the audit log records who and where it went. Uses
 * e2e-user-<ts> accounts. (A deleted account is renamed to deleted-<id>@deleted.invalid, which
 * e2e:reset's 'e2e-user-%' match does not catch; those placeholders accumulate harmlessly -- the
 * Users page and counts exclude them, and the real e2e-user email is freed for reuse.)
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const OWNER_EMAIL = `e2e-user-${RUN}-owner@example.com`;
const OWNER_NAME = `E2E Owner ${RUN}`;
const RECIPIENT_EMAIL = `e2e-user-${RUN}-recipient@example.com`;
const RECIPIENT_NAME = `E2E Recipient ${RUN}`;
const EMPTY_EMAIL = `e2e-user-${RUN}-empty@example.com`;
const EMPTY_NAME = `E2E Empty ${RUN}`;
const PASSWORD = 'Zebra-lantern-quartz-42'; // gitleaks:allow

let adminCtx: BrowserContext;
let admin: Page;
const userIds: Record<string, string> = {};
let ownerProjectName = '';

async function a11y() {
  const results = await new AxeBuilder({ page: admin }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

/** Creates the user as admin, then settles their one-time password through the API. */
async function createUser(browser: import('@playwright/test').Browser, email: string, name: string) {
  const res = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name, role: 'architect' } });
  expect(res.status()).toBe(201);
  const body = await res.json();
  userIds[email] = body.user.id;
  const ctx = await browser.newContext();
  expect((await ctx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email, password: body.temporaryPassword } })).status()).toBe(200);
  expect((await ctx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status()).toBe(200);
  return ctx;
}

const rowOf = (email: string) => admin.getByTestId(`user-row-${userIds[email]}`);

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill(ADMIN_EMAIL);
  await admin.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  const ownerCtx = await createUser(browser, OWNER_EMAIL, OWNER_NAME);
  ownerProjectName = `Owner project ${RUN}`;
  const project = await ownerCtx.request.post(`${API_BASE_URL}/projects`, { data: { name: ownerProjectName } });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).project.id as string;
  const diagram = await ownerCtx.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, { data: { name: 'Owner diagram', diagramTypeId: 'flowchart' } });
  expect(diagram.status()).toBe(201);
  await ownerCtx.close();

  (await createUser(browser, RECIPIENT_EMAIL, RECIPIENT_NAME)).close();
  (await createUser(browser, EMPTY_EMAIL, EMPTY_NAME)).close();
});

test.afterAll(async () => {
  await adminCtx?.close();
});

test('the admin has no Delete button on their own row', async () => {
  await admin.goto('/?admin=users');
  const own = admin.locator('tr', { hasText: ADMIN_EMAIL }).first();
  await expect(own).toBeVisible();
  await expect(own.locator('[data-testid^="delete-user-"]')).toHaveCount(0);
  await expect(admin.getByTestId(`delete-user-${userIds[OWNER_EMAIL]}`)).toBeVisible();
});

test('deleting a user who owns content needs a transfer target, then shows the result', async ({ browser }) => {
  await admin.goto('/?admin=users');
  await admin.getByTestId(`delete-user-${userIds[OWNER_EMAIL]}`).click();
  const dialog = admin.getByTestId('delete-user-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${OWNER_NAME} owns 1 project and 1 diagram`);
  await expect(admin.getByTestId('delete-user-last-admin')).toHaveCount(0);

  const confirm = admin.getByTestId('confirm-delete-user');
  await expect(admin.getByTestId('delete-user-transfer')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await a11y(); // with the dialog open

  await admin.getByTestId('delete-user-transfer').selectOption({ label: `${RECIPIENT_NAME} (${RECIPIENT_EMAIL})` });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(admin.getByTestId('delete-user-dialog')).toHaveCount(0);
  await expect(admin.getByTestId('delete-user-status')).toHaveText(`Deleted ${OWNER_NAME}; transferred 1 project and 1 diagram to ${RECIPIENT_NAME}.`);
  await expect(rowOf(OWNER_EMAIL)).toHaveCount(0);

  // The recipient now has the project.
  const ctx = await browser.newContext();
  expect((await ctx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email: RECIPIENT_EMAIL, password: PASSWORD } })).status()).toBe(200);
  const projects = (await (await ctx.request.get(`${API_BASE_URL}/projects`)).json()).projects as { name: string }[];
  expect(projects.map((p) => p.name)).toContain(ownerProjectName);
  await ctx.close();

  // The deleted user cannot sign in any more.
  const gone = await admin.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email: OWNER_EMAIL, password: PASSWORD } });
  expect(gone.status()).toBe(401);
});

test('deleting a user who owns nothing needs no transfer', async () => {
  await admin.goto('/?admin=users');
  await admin.getByTestId(`delete-user-${userIds[EMPTY_EMAIL]}`).click();
  const dialog = admin.getByTestId('delete-user-dialog');
  await expect(dialog).toContainText(`${EMPTY_NAME} owns 0 projects and 0 diagrams`);
  await expect(admin.getByTestId('delete-user-transfer')).toHaveCount(0);
  await expect(admin.getByTestId('confirm-delete-user')).toBeEnabled();
  await admin.getByTestId('confirm-delete-user').click();
  await expect(admin.getByTestId('delete-user-status')).toHaveText(`Deleted ${EMPTY_NAME}.`);
  await expect(rowOf(EMPTY_EMAIL)).toHaveCount(0);
});

test('the audit log shows who was deleted and where their content went', async () => {
  await admin.goto('/?admin=audit');
  await expect(admin.getByTestId('audit-log')).toBeVisible();
  const rows = admin.locator('[data-testid^="audit-row-"]').filter({ hasText: 'User deleted' });
  const ownerRow = rows.filter({ hasText: OWNER_EMAIL });
  await expect(ownerRow).toHaveCount(1);
  await expect(ownerRow).toContainText(OWNER_NAME);
  await expect(ownerRow).toContainText(`1 project and 1 diagram transferred to ${RECIPIENT_EMAIL}`);
  await expect(ownerRow).toContainText(ADMIN_EMAIL);
  const emptyRow = rows.filter({ hasText: EMPTY_EMAIL });
  await expect(emptyRow).toHaveCount(1);
  await expect(emptyRow).not.toContainText('transferred');
});

test('the delete dialog fits a 390px screen', async ({ browser }) => {
  // A fresh user to open the dialog on (the earlier ones are gone).
  const email = `e2e-user-${RUN}-phone@example.com`;
  (await createUser(browser, email, `E2E Phone ${RUN}`)).close();
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto('/?admin=users');
  await admin.getByTestId(`delete-user-${userIds[email]}`).click();
  await expect(admin.getByTestId('delete-user-dialog')).toBeVisible();
  // The admin console is desktop-only by design (the Users table is wider than a phone), so the page
  // itself scrolls; what must hold is that the dialog fits the screen.
  const box = await admin.getByTestId('delete-user-dialog').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
  await expect(admin.getByTestId('confirm-delete-user')).toBeInViewport();
  await admin.setViewportSize({ width: 1280, height: 900 });
});
