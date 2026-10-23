import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';
const MOCK_PROVIDER = 'mock-provider';
const MOCK_MODEL = 'mock-model-id';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-zs0 (estimated cost + price editor, admin only) and canvas-4k9 (token counts in the chat
 * panel and on the account screen, hideable for non-admins). Needs the API on AI_PROVIDER=mock.
 * The dev database accumulates usage, so figures are asserted relative, never exact. The tests
 * that change shared state (the mock model's price, the show-usage setting) restore it.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let adminCtx: BrowserContext;
let admin: Page;
let architectCtx: BrowserContext;
let architect: Page;
let adminDiagramId = '';
let architectDiagramId = '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
}

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function removeMockPrice(page: Page) {
  await page.request.delete(`${API_BASE_URL}/admin/ai-prices`, { params: { provider: MOCK_PROVIDER, modelId: MOCK_MODEL } });
}

async function setShowUsage(page: Page, show: boolean) {
  const res = await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { showUsageToUsers: show } });
  expect(res.status()).toBe(200);
}

async function openChat(page: Page, diagramId: string) {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('rail-tab-chat').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
}

async function sendChat(page: Page, text: string) {
  const before = await page.locator('[data-testid="chat-message-assistant"]').count();
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
  await expect(page.locator('[data-testid="chat-message-assistant"]')).toHaveCount(before + 1);
}

const usageLines = (page: Page) => page.locator('[data-testid^="chat-usage-"]:not([data-testid="chat-usage-total"])');

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext();
  admin = await adminCtx.newPage();
  await signIn(admin, ADMIN_EMAIL, ADMIN_PASSWORD);
  await admin.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
  await setShowUsage(admin, true);
  await removeMockPrice(admin);
  const d = await admin.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, { data: { name: `Usage chat ${Date.now()}`, diagramTypeId: 'flowchart' } });
  expect(d.status()).toBe(201);
  adminDiagramId = (await d.json()).diagram.id;

  architectCtx = await browser.newContext();
  architect = await architectCtx.newPage();
  await signIn(architect, ARCHITECT_EMAIL, ARCHITECT_PASSWORD);
  const p = await architect.request.post(`${API_BASE_URL}/projects`, { data: { name: `Usage project ${Date.now()}` } });
  expect(p.status()).toBe(201);
  const projectId = (await p.json()).project.id as string;
  const ad = await architect.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, { data: { name: 'Architect usage chat', diagramTypeId: 'flowchart' } });
  expect(ad.status()).toBe(201);
  architectDiagramId = (await ad.json()).diagram.id;
});

test.afterAll(async () => {
  try {
    await setShowUsage(admin, true);
    await removeMockPrice(admin);
  } finally {
    await adminCtx?.close();
    await architectCtx?.close();
  }
});

test('a chat reply shows its token count, the conversation total updates, and no cost appears', async () => {
  await openChat(admin, adminDiagramId);
  await sendChat(admin, 'Add a shape called Alpha');
  await expect(usageLines(admin)).toHaveCount(1);
  await expect(usageLines(admin).first()).toContainText(/\d[\d,]* tokens/);
  await expect(admin.getByTestId('chat-usage-total')).toContainText(/1 request/);

  await sendChat(admin, 'Add a shape called Beta');
  await expect(usageLines(admin)).toHaveCount(2);
  await expect(admin.getByTestId('chat-usage-total')).toContainText(/2 requests/);

  const panelText = (await admin.getByTestId('rail-tab-chat').locator('xpath=ancestor::*[contains(@class,"rail")][1]').textContent()) ?? '';
  expect(panelText).not.toContain('$');
  await a11y(admin);
});

test('the mock model shows as unpriced; pricing it produces a cost; errors; edit; remove', async () => {
  await admin.goto('/?admin=ai-usage');
  await expect(admin.getByTestId('ai-usage-table')).toBeVisible();
  await expect(admin.getByTestId('ai-usage-unpriced-note')).toBeVisible();
  const add = admin.locator('[data-testid^="ai-price-add-"]', { hasText: MOCK_MODEL });
  await expect(add).toBeVisible();

  // Quick-add fills provider and model; a negative price is refused.
  await add.click();
  await expect(admin.getByTestId('ai-price-provider')).toHaveValue(MOCK_PROVIDER);
  await expect(admin.getByTestId('ai-price-model')).toHaveValue(MOCK_MODEL);
  await admin.getByTestId('ai-price-input').fill('-1');
  await admin.getByTestId('ai-price-output').fill('15');
  await admin.getByTestId('ai-price-save').click();
  await expect(admin.getByTestId('ai-price-error')).toBeVisible();

  await admin.getByTestId('ai-price-input').fill('3');
  await admin.getByTestId('ai-price-save').click();
  const row = admin.locator('[data-testid^="ai-price-row-"]', { hasText: MOCK_MODEL });
  await expect(row).toBeVisible();
  await expect(row).toContainText('15');

  // The mock model's tokens are now priced: its cost is non-zero.
  await expect(admin.getByTestId('ai-usage-total-cost')).not.toHaveText('$0.00');
  await expect(admin.getByTestId('ai-usage-total-cost')).toContainText('$');
  const userRow = admin.locator('[data-testid^="ai-usage-row-"]', { hasText: ADMIN_EMAIL });
  await expect(userRow).toContainText('$');
  await expect(admin.locator('[data-testid^="ai-price-add-"]', { hasText: MOCK_MODEL })).toHaveCount(0);
  await a11y(admin);

  // Edit: the form fills from the row; a new input price replaces the old one.
  await row.locator('[data-testid^="ai-price-edit-"]').click();
  await expect(admin.getByTestId('ai-price-input')).toHaveValue('3');
  await admin.getByTestId('ai-price-input').fill('4');
  await admin.getByTestId('ai-price-save').click();
  await expect(row.locator('td').nth(2)).toHaveText('4');

  // Remove with confirmation: the model is unpriced again.
  await row.locator('[data-testid^="ai-price-remove-"]').click();
  await admin.getByTestId('ai-price-remove-confirm').click();
  await expect(admin.locator('[data-testid^="ai-price-row-"]', { hasText: MOCK_MODEL })).toHaveCount(0);
  await expect(admin.getByTestId('ai-usage-unpriced-note')).toBeVisible();
  await expect(admin.locator('[data-testid^="ai-price-add-"]', { hasText: MOCK_MODEL })).toBeVisible();
});

test('the Est. cost column sorts', async () => {
  await admin.goto('/?admin=ai-usage');
  const header = admin.locator('th', { has: admin.getByTestId('ai-usage-sort-estimatedCost') });
  await expect(header).toHaveAttribute('aria-sort', 'none');
  await admin.getByTestId('ai-usage-sort-estimatedCost').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await admin.getByTestId('ai-usage-sort-estimatedCost').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
});

test('a non-admin sees token counts by default, and the account screen shows their usage', async () => {
  await openChat(architect, architectDiagramId);
  await sendChat(architect, 'Add a shape called Gamma');
  await expect(usageLines(architect)).toHaveCount(1);
  await expect(architect.getByTestId('chat-usage-total')).toBeVisible();

  await architect.goto('/?account=password');
  await expect(architect.getByTestId('change-password-page')).toBeVisible();
  const mine = architect.getByTestId('my-ai-usage');
  await expect(mine).toBeVisible();
  await expect(mine).toContainText(/[1-9][\d,]* tokens/);
  expect(((await mine.textContent()) ?? '')).not.toContain('$');
});

test('turning the setting off hides counts from the architect but not from the admin', async () => {
  await admin.goto('/?admin=ai-personas');
  const toggle = admin.getByTestId('ai-show-usage-toggle');
  await expect(toggle).toBeChecked();
  await toggle.click(); // controlled by the server round trip, so not uncheck()
  await expect(toggle).not.toBeChecked();
  // Persisted: the toggle reflects the server after a reload.
  await admin.reload();
  await expect(admin.getByTestId('ai-show-usage-toggle')).not.toBeChecked();

  await architect.goto('/');
  await openChat(architect, architectDiagramId);
  await expect(architect.locator('[data-testid="chat-message-assistant"]').first()).toBeVisible();
  await expect(usageLines(architect)).toHaveCount(0);
  await expect(architect.getByTestId('chat-usage-total')).toHaveCount(0);
  await sendChat(architect, 'Add a shape called Delta');
  await expect(usageLines(architect)).toHaveCount(0);
  await expect(architect.getByTestId('chat-usage-total')).toHaveCount(0);
  await architect.goto('/?account=password');
  await expect(architect.getByTestId('change-password-page')).toBeVisible();
  await expect(architect.getByTestId('my-ai-usage')).toHaveCount(0);

  // The admin still sees counts on the architect's diagram and on their own account.
  await openChat(admin, architectDiagramId);
  await expect(usageLines(admin).first()).toBeVisible();
  await expect(admin.getByTestId('chat-usage-total')).toBeVisible();

  // Restore (the afterAll does too, in case an assertion above failed).
  await admin.goto('/?admin=ai-personas');
  await admin.getByTestId('ai-show-usage-toggle').click();
  await expect(admin.getByTestId('ai-show-usage-toggle')).toBeChecked();
  await architect.goto('/?account=password');
  await expect(architect.getByTestId('my-ai-usage')).toBeVisible();
});

test('the AI usage page fits a 390px screen and passes axe with the price editor', async () => {
  await admin.goto('/?admin=ai-usage');
  await expect(admin.getByTestId('ai-prices')).toBeVisible();
  await a11y(admin);
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto('/?admin=ai-usage');
  await expect(admin.getByTestId('ai-usage-table')).toBeVisible();
  const { scrollWidth, clientWidth } = await admin.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  await admin.setViewportSize({ width: 1280, height: 720 });
});
