import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { saveDsl } from './save-helpers';

const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * canvas-8uh1.3: drill-down links between diagrams. An element's link badge opens the other diagram; the
 * links followed show as a trail (kept in the history entry, so reload and Back work); the Links tab lists
 * what a diagram links to and what links to it; a link that can't be opened says so. Anyone who can read a
 * diagram can follow its links.
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const RUN = Date.now();
const PASSWORD = 'Meadow-cobalt-ember-73'; // gitleaks:allow
const CONTEXT_NAME = `Context ${RUN}`;
const CONTAINERS_NAME = `Payments containers ${RUN}`;

const CONTEXT_DSL = [
  'C4Context',
  '  Person(customer, "Customer")',
  '  System(pay, "Payments System")',
  '  System(ext, "External System")',
  '',
].join('\n');

let adminCtx: BrowserContext;
let viewerCtx: BrowserContext;
let admin: Page;
let viewer: Page;
let projectId = '';
let contextId = '';
let containersId = '';

async function createDiagram(name: string, diagramTypeId: string, dsl: string): Promise<string> {
  const created = await admin.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, { data: { name, diagramTypeId } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).diagram.id as string;
  expect((await saveDsl(admin.request, API_BASE_URL, id, dsl)).status()).toBe(200);
  return id;
}

async function open(page: Page, diagramId: string): Promise<void> {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function save(page: Page): Promise<void> {
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
}

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  admin = await adminCtx.newPage();
  await admin.goto('/');
  await admin.getByTestId('login-email').fill('admin@example.com');
  await admin.getByTestId('login-password').fill('admin-dev-password');
  await admin.getByTestId('login-submit').click();
  await expectSignedIn(admin);

  projectId = (await (await admin.request.post(`${API_BASE_URL}/projects`, { data: { name: `Links ${RUN}` } })).json()).project.id;
  contextId = await createDiagram(CONTEXT_NAME, 'c4-context', CONTEXT_DSL);
  containersId = await createDiagram(CONTAINERS_NAME, 'c4-container', 'C4Container\n  Container(api, "API", "Python")\n');

  // A person with no grant on the project: they can read everything, change nothing.
  const email = `e2e-user-${RUN}-links@example.com`;
  const user = await admin.request.post(`${API_BASE_URL}/admin/users`, { data: { email, name: `E2E Links ${RUN}`, role: 'architect' } });
  expect(user.status()).toBe(201);
  const body = await user.json();
  viewerCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  expect((await viewerCtx.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email, password: body.temporaryPassword } })).status()).toBe(200);
  expect(
    (await viewerCtx.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: body.temporaryPassword, newPassword: PASSWORD } })).status(),
  ).toBe(200);
  viewer = await viewerCtx.newPage();
});

test.afterAll(async () => {
  await viewerCtx?.close();
  await adminCtx?.close();
});

test('link a system to the Container diagram the picker suggests, and save', async () => {
  await open(admin, contextId);
  await expect(admin.getByTestId('link-to-diagram')).toHaveCount(0);
  await admin.getByTestId('node-pay').click();
  await admin.getByTestId('link-to-diagram').click();

  await expect(admin.getByTestId('link-picker')).toBeVisible();
  // A Context diagram's next level down is suggested and already chosen.
  await expect(admin.getByTestId('link-picker-type')).toHaveValue('c4-container');
  await expect(admin.getByTestId('link-picker-type').locator('option:checked')).toHaveText(/suggested/);
  await admin.getByTestId('link-picker-project').selectOption(projectId);
  await expect(admin.getByTestId(`link-picker-result-${containersId}`)).toBeVisible();
  await admin.getByTestId(`link-picker-result-${containersId}`).click();
  await expect(admin.getByTestId('link-picker')).toBeHidden();

  // The badge shows at once, with the target's title; the change is unsaved until Save.
  await expect(admin.getByTestId('diagram-link-badge-pay')).toHaveAttribute('data-status', 'available');
  await expect(admin.getByTestId('diagram-link-badge-customer')).toHaveCount(0);
  await save(admin);

  await admin.getByTestId('rail-tab-dsl').click();
  const text = await admin.getByTestId('dsl-panel').inputValue();
  expect(text).toContain('links:');
  expect(text).toContain(containersId);

  await admin.getByTestId('rail-tab-links').click();
  await expect(admin.getByTestId('link-row-pay')).toContainText(CONTAINERS_NAME);
  await expect(admin.getByTestId('links-broken')).toHaveCount(0);
});

test('following the badge opens the other diagram with the trail, and its Links tab says where it is used', async () => {
  await open(admin, contextId);
  await expect(admin.getByTestId('link-trail')).toHaveCount(0);
  await admin.getByTestId('diagram-link-badge-pay').click();

  await expect(admin).toHaveURL(new RegExp(`diagramId=${containersId}`));
  await expect(admin.getByTestId('node-api')).toBeVisible();
  await expect(admin.getByTestId('link-trail')).toContainText(CONTEXT_NAME);
  await expect(admin.getByTestId('link-trail')).toContainText(CONTAINERS_NAME);

  await admin.getByTestId('rail-tab-links').click();
  await expect(admin.getByTestId('links-from-empty')).toBeVisible();
  await expect(admin.getByTestId('used-in-list')).toContainText(CONTEXT_NAME);
  await admin.getByTestId(`used-in-open-${contextId}`).click();
  await expect(admin).toHaveURL(new RegExp(`diagramId=${contextId}`));
  await expect(admin.getByTestId('node-pay')).toBeVisible();
});

test('the trail link and the browser Back button return, and a reload keeps the trail', async () => {
  await open(admin, contextId);
  await admin.getByTestId('diagram-link-badge-pay').click();
  await expect(admin.getByTestId('link-trail-0')).toBeVisible();

  // Reload: the trail is in the history entry.
  await admin.reload();
  await expect(admin.getByTestId('node-api')).toBeVisible();
  await expect(admin.getByTestId('link-trail-0')).toHaveText(CONTEXT_NAME);

  // Trail link: back up, and the trail is cut.
  await admin.getByTestId('link-trail-0').click();
  await expect(admin).toHaveURL(new RegExp(`diagramId=${contextId}`));
  await expect(admin.getByTestId('node-pay')).toBeVisible();
  await expect(admin.getByTestId('link-trail')).toHaveCount(0);

  // Browser Back from the opened diagram.
  await admin.getByTestId('diagram-link-badge-pay').click();
  await expect(admin.getByTestId('link-trail-0')).toBeVisible();
  await admin.goBack();
  await expect(admin).toHaveURL(new RegExp(`diagramId=${contextId}`));
  await expect(admin.getByTestId('node-pay')).toBeVisible();
  await expect(admin.getByTestId('link-trail')).toHaveCount(0);
  // ...and Forward brings the trail back.
  await admin.goForward();
  await expect(admin.getByTestId('node-api')).toBeVisible();
  await expect(admin.getByTestId('link-trail-0')).toHaveText(CONTEXT_NAME);
});

test('Create and link makes a new diagram in the project and links it', async () => {
  await open(admin, contextId);
  await admin.getByTestId('node-customer').click();
  await admin.getByTestId('link-to-diagram').click();
  await expect(admin.getByTestId('link-picker-new-name')).toHaveValue('Customer');
  await admin.getByTestId('link-picker-new-name').fill(`Customer app ${RUN}`);
  await expect(admin.getByTestId('link-picker-new-type')).toHaveValue('c4-container');
  await admin.getByTestId('link-picker-create').click();
  await expect(admin.getByTestId('link-picker')).toBeHidden();
  await expect(admin.getByTestId('diagram-link-badge-customer')).toHaveAttribute('data-status', 'available');
  await save(admin);

  await admin.getByTestId('rail-tab-links').click();
  await expect(admin.getByTestId('link-row-customer')).toContainText(`Customer app ${RUN}`);

  await admin.getByTestId('diagram-link-badge-customer').click();
  await expect(admin.getByTestId('link-trail')).toContainText(CONTEXT_NAME);
  // The trail's last entry is the diagram now open.
  await expect(admin.getByTestId('link-trail').locator('[aria-current="page"]')).toHaveText(`Customer app ${RUN}`);
  await expect(admin).not.toHaveURL(new RegExp(`diagramId=${contextId}`));

  // The new diagram is in the same project.
  const search = await admin.request.get(`${API_BASE_URL}/projects/${projectId}/diagrams?query=${encodeURIComponent(`Customer app ${RUN}`)}`);
  expect((await search.json()).diagrams).toHaveLength(1);
});

test('a link to a diagram in the bin shows the broken badge and counts on the Links tab', async () => {
  const doomedId = await createDiagram(`Doomed ${RUN}`, 'c4-container', 'C4Container\n  Container(x, "X")\n');
  await open(admin, contextId);
  await admin.getByTestId('node-ext').click();
  await admin.getByTestId('link-to-diagram').click();
  await admin.getByTestId('link-picker-search').fill(`Doomed ${RUN}`);
  await admin.getByTestId(`link-picker-result-${doomedId}`).click();
  await save(admin);
  await expect(admin.getByTestId('diagram-link-badge-ext')).toHaveAttribute('data-status', 'available');

  expect((await admin.request.delete(`${API_BASE_URL}/diagrams/${doomedId}`)).status()).toBe(204);
  await open(admin, contextId);
  const badge = admin.getByTestId('diagram-link-badge-ext');
  await expect(badge).toHaveAttribute('data-status', 'deleted');
  await expect(admin.getByTestId('links-broken')).toHaveText('1');
  // It does not open.
  await badge.click({ force: true }); // aria-disabled: Playwright waits for an enabled target otherwise
  await expect(admin.getByTestId('node-ext')).toBeVisible();
  await expect(admin).toHaveURL(new RegExp(`diagramId=${contextId}`));

  await admin.getByTestId('rail-tab-links').click();
  await expect(admin.getByTestId('link-row-ext')).toHaveAttribute('data-status', 'deleted');
  await expect(admin.getByTestId('link-open-ext')).toHaveCount(0);

  // Remove link from the tab drops the badge and the count; saving keeps it gone.
  await admin.getByTestId('link-remove-ext').click();
  await expect(admin.getByTestId('diagram-link-badge-ext')).toHaveCount(0);
  await expect(admin.getByTestId('links-broken')).toHaveCount(0);
  await save(admin);
});

test('a read-only viewer can follow a badge but not change links', async () => {
  await open(viewer, contextId);
  await expect(viewer.getByTestId('read-only-badge')).toBeVisible();
  await viewer.getByTestId('node-pay').click();
  await expect(viewer.getByTestId('link-to-diagram')).toHaveCount(0);
  await expect(viewer.getByTestId('remove-diagram-link')).toHaveCount(0);

  await viewer.getByTestId('rail-tab-links').click();
  await expect(viewer.getByTestId('link-open-pay')).toBeVisible();
  await expect(viewer.getByTestId('link-change-pay')).toHaveCount(0);
  await expect(viewer.getByTestId('link-remove-pay')).toHaveCount(0);

  await viewer.getByTestId('diagram-link-badge-pay').click();
  await expect(viewer).toHaveURL(new RegExp(`diagramId=${containersId}`));
  await expect(viewer.getByTestId('node-api')).toBeVisible();
  await expect(viewer.getByTestId('link-trail')).toContainText(CONTEXT_NAME);
});
