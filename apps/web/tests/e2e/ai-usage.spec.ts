import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-9af: the AI usage admin page. Needs the API on AI_PROVIDER=mock, whose chat turns record
 * estimated token usage. The dev database accumulates usage across runs, so totals are asserted
 * relative (at least what this run produced), never exact.
 */
test.describe.configure({ mode: 'serial', timeout: 60_000 });

let page: Page;
let adminId = '';

const num = async (page: Page, testId: string) => Number(((await page.getByTestId(testId).textContent()) ?? '').replace(/[^\d]/g, ''));

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
  adminId = (await (await page.request.get(`${API_BASE_URL}/auth/me`)).json()).user.id;

  // AI chat is off by default (FR-020). Two chat turns on a fresh diagram produce usage.
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
  const created = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: { name: `AI usage ${Date.now()}`, diagramTypeId: 'flowchart' },
  });
  expect(created.status()).toBe(201);
  const diagramId = (await created.json()).diagram.id as string;
  for (const label of ['Alpha', 'Beta']) {
    const turn = await page.request.post(`${API_BASE_URL}/diagrams/${diagramId}/chat/messages`, {
      data: { message: `add a node called ${label}`, currentDslContent: 'flowchart TD\n' },
    });
    expect(turn.status()).toBe(200);
  }
});

test.afterAll(async () => {
  await page?.context().close();
});

test('the user row shows at least this run\'s requests and non-zero tokens; totals are non-zero', async () => {
  await page.goto('/?admin=ai-usage');
  await expect(page.getByTestId('ai-usage-table')).toBeVisible();
  const row = page.getByTestId(`ai-usage-row-${adminId}`);
  await expect(row).toBeVisible();
  const cells = await row.locator('td').allTextContents();
  const [requests, input, output, total] = cells.slice(0, 4).map((c) => Number(c.replace(/[^\d]/g, '')));
  expect(requests).toBeGreaterThanOrEqual(2);
  expect(input).toBeGreaterThan(0);
  expect(output).toBeGreaterThan(0);
  expect(total).toBe(input + output);

  expect(await num(page, 'ai-usage-total-requests')).toBeGreaterThanOrEqual(2);
  expect(await num(page, 'ai-usage-total-tokens')).toBeGreaterThanOrEqual(total);
  expect(await num(page, 'ai-usage-total-input')).toBeGreaterThan(0);
  expect(await num(page, 'ai-usage-total-output')).toBeGreaterThan(0);
  await a11y(page);
});

test('clicking the Total header toggles the sort direction', async () => {
  await page.goto('/?admin=ai-usage');
  const header = page.locator('th', { has: page.getByTestId('ai-usage-sort-totalTokens') });
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await page.getByTestId('ai-usage-sort-totalTokens').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await page.getByTestId('ai-usage-sort-totalTokens').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  // Sorting another column moves aria-sort there.
  await page.getByTestId('ai-usage-sort-requests').click();
  await expect(page.locator('th', { has: page.getByTestId('ai-usage-sort-requests') })).toHaveAttribute('aria-sort', 'descending');
  await expect(header).toHaveAttribute('aria-sort', 'none');
});

test('drilling into a user shows today (UTC) by day and a model row, and Back returns', async () => {
  await page.goto('/?admin=ai-usage');
  await page.getByTestId(`ai-usage-user-${adminId}`).click();
  await expect(page.getByTestId('ai-usage-detail')).toBeVisible();

  const today = new Date().toISOString().slice(0, 10);
  const byDay = page.getByTestId('ai-usage-by-day');
  // A run started just before UTC midnight could land on yesterday; either way today's row or the
  // previous day's must exist, and at least one day row is present.
  await expect(byDay.locator('tbody tr').first()).toBeVisible();
  await expect(byDay).toContainText(today);

  const models = page.getByTestId('ai-usage-by-model').locator('tbody tr');
  await expect(models.first()).toBeVisible();
  expect(((await models.first().locator('th').textContent()) ?? '').trim().length).toBeGreaterThan(3);
  await a11y(page);

  await page.getByTestId('ai-usage-back').click();
  await expect(page.getByTestId('ai-usage-table')).toBeVisible();
});

test('a custom range in the past is empty', async () => {
  await page.goto('/?admin=ai-usage');
  await page.getByTestId('ai-usage-period').selectOption('custom');
  await page.getByTestId('ai-usage-from').fill('2020-01-01');
  await page.getByTestId('ai-usage-to').fill('2020-01-31');
  await expect(page.getByTestId('ai-usage-empty')).toBeVisible();
  await expect(page.getByTestId('ai-usage-table')).toHaveCount(0);
  await expect(page.getByTestId('ai-usage-total-tokens')).toHaveText('0');
});

test('the page fits a 390px screen without page-level horizontal scroll', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?admin=ai-usage');
  await expect(page.getByTestId('ai-usage-table')).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  await page.setViewportSize({ width: 1280, height: 720 });
});
