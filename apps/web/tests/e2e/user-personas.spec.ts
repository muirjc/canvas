import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2sk: a user's personas narrow the diagram-type pickers (New Diagram, Import from
 * Template) with a "Show all diagram types" escape hatch, and admins edit them on the Users page.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const RUN = Date.now();
const EMAIL = `e2e-user-${RUN}-personas@example.com`;
const NAME = `E2E Personas ${RUN}`;
const PASSWORD = 'Zebra-lantern-quartz-42'; // gitleaks:allow
const KEY = 'canvas.showAllDiagramTypes';

let adminCtx: BrowserContext;
let admin: Page;
let userCtx: BrowserContext;
let user: Page;
let userId = '';
let projectId = '';
let withTechnical = '';
let withoutTechnical = '';
let templateTypes: { id: string; personas: string[] }[] = [];

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function reloadUser(clearRemembered = true) {
  await user.goto(`/?projectId=${projectId}`);
  if (clearRemembered) {
    await user.evaluate((k) => window.localStorage.removeItem(k), KEY);
    await user.goto(`/?projectId=${projectId}`);
  }
  await expect(user.getByTestId('new-diagram')).toBeVisible();
}

async function openNewDiagram() {
  await user.getByTestId('new-diagram').click();
  await expect(user.getByTestId('confirm-new-diagram')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill(ADMIN_EMAIL);
  await admin.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  const types = (await (await admin.request.get(`${API_BASE_URL}/diagram-types`)).json()).diagramTypes as { id: string; personas: string[] }[];
  withTechnical = types.find((t) => t.personas.includes('Technical') && t.personas.length < 4)?.id ?? '';
  withoutTechnical = types.find((t) => !t.personas.includes('Technical'))?.id ?? '';
  expect(withTechnical, 'a type tagged Technical but not for every persona').toBeTruthy();
  expect(withoutTechnical, 'a type not tagged Technical').toBeTruthy();
  templateTypes = types;

  const created = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email: EMAIL, name: NAME, role: 'architect' } });
  expect(created.status()).toBe(201);
  const body = await created.json();
  userId = body.user.id;
  userCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  expect((await userCtx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email: EMAIL, password: body.temporaryPassword } })).status()).toBe(200);
  expect((await userCtx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status()).toBe(200);
  const project = await userCtx.request.post(`${API_BASE_URL}/projects`, { data: { name: `Personas project ${RUN}` } });
  expect(project.status()).toBe(201);
  projectId = (await project.json()).project.id;
  user = await userCtx.newPage();
});

test.afterAll(async () => {
  await adminCtx?.close();
  await userCtx?.close();
});

test('a user with no personas sees every diagram type and no checkbox', async () => {
  await reloadUser();
  await openNewDiagram();
  await expect(user.getByTestId(`diagram-type-${withTechnical}`)).toBeVisible();
  await expect(user.getByTestId(`diagram-type-${withoutTechnical}`)).toBeVisible();
  await expect(user.getByTestId('show-all-diagram-types')).toHaveCount(0);
  await expect(user.getByTestId('diagram-types-no-match')).toHaveCount(0);
});

test('the admin sets personas on the Users page; the user then sees only matching types', async () => {
  await admin.goto('/?admin=users');
  await expect(admin.getByTestId(`user-personas-${userId}`)).toHaveText('None');
  await admin.getByTestId(`edit-personas-${userId}`).click();
  await expect(admin.getByTestId('edit-personas-dialog')).toBeVisible();
  await admin.getByTestId('persona-Technical').check();
  await a11y(admin); // with the edit dialog open
  await admin.getByTestId('save-personas').click();
  await expect(admin.getByTestId('edit-personas-dialog')).toHaveCount(0);
  await expect(admin.getByTestId(`user-personas-${userId}`)).toHaveText('Technical');

  // The user's existing session picks it up on the next page load.
  await reloadUser();
  await openNewDiagram();
  await expect(user.getByTestId(`diagram-type-${withTechnical}`)).toBeVisible();
  await expect(user.getByTestId(`diagram-type-${withoutTechnical}`)).toHaveCount(0);
  await expect(user.getByTestId('show-all-diagram-types')).not.toBeChecked();
  await a11y(user); // the filtered dialog
});

test('Show all reveals every type, is remembered after a reload, and hiding a selected type disables Create', async () => {
  await reloadUser();
  await openNewDiagram();
  await user.getByTestId('show-all-diagram-types').check();
  await expect(user.getByTestId(`diagram-type-${withoutTechnical}`)).toBeVisible();
  await expect(user.getByTestId(`diagram-type-${withTechnical}`)).toBeVisible();
  expect(await user.evaluate((k) => window.localStorage.getItem(k), KEY)).toBe('true');

  await reloadUser(false);
  await openNewDiagram();
  await expect(user.getByTestId('show-all-diagram-types')).toBeChecked();
  await expect(user.getByTestId(`diagram-type-${withoutTechnical}`)).toBeVisible();

  // Select a type outside the persona, then hide it by unticking: it no longer counts as selected.
  await user.getByTestId(`diagram-type-${withoutTechnical}`).check();
  await expect(user.getByTestId('confirm-new-diagram')).toBeEnabled();
  await user.getByTestId('show-all-diagram-types').uncheck();
  await expect(user.getByTestId(`diagram-type-${withoutTechnical}`)).toHaveCount(0);
  await expect(user.getByTestId('confirm-new-diagram')).toBeDisabled();
});

test('Import from Template filters the same way', async () => {
  await reloadUser();
  await user.getByTestId('import-template-button').click();
  await expect(user.getByTestId('confirm-import-template')).toBeVisible();
  // The types load after the dialog opens: wait for them before reading the list once.
  await expect(user.locator('[data-testid^="template-type-"]').first()).toBeVisible();
  const shownFiltered = await user.locator('[data-testid^="template-type-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('template-type-', '')));
  expect(shownFiltered.length).toBeGreaterThan(0);
  const byId = Object.fromEntries(templateTypes.map((t) => [t.id, t.personas]));
  for (const id of shownFiltered) expect(byId[id], id).toContain('Technical');

  const checkbox = user.getByTestId('show-all-diagram-types');
  await expect(checkbox).toBeVisible();
  await checkbox.check();
  const shownAll = await user.locator('[data-testid^="template-type-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('template-type-', '')));
  expect(shownAll.length).toBeGreaterThanOrEqual(shownFiltered.length);
  for (const id of shownFiltered) expect(shownAll).toContain(id);
  // Any template type outside the persona appears only once "all" is ticked.
  const outside = shownAll.filter((id) => !byId[id]?.includes('Technical'));
  expect(shownAll.length).toBe(shownFiltered.length + outside.length);
  await user.evaluate((k) => window.localStorage.removeItem(k), KEY);
});

test('Add user with personas shows them in the new row', async () => {
  const email = `e2e-user-${RUN}-added@example.com`;
  await admin.goto('/?admin=users');
  await admin.getByTestId('users-add').click();
  await admin.getByTestId('add-user-email').fill(email);
  await admin.getByTestId('add-user-name').fill(`E2E Added ${RUN}`);
  await admin.getByTestId('add-user-persona-Business').check();
  await admin.getByTestId('add-user-persona-Solution').check();
  await admin.getByTestId('add-user-submit').click();
  await expect(admin.getByTestId('one-time-password')).toBeVisible();
  await admin.getByTestId('one-time-password-done').click();
  const row = admin.locator('tr', { hasText: email });
  await expect(row).toBeVisible();
  await expect(row.locator('[data-testid^="user-personas-"]')).toHaveText('Business, Solution');
});
