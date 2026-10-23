import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-rfv: assistant replies render as formatted text (a safe Markdown subset, never HTML) with
 * a separate note for edits made / not made; user messages keep their line breaks. Needs the API
 * on AI_PROVIDER=mock (its "show a formatted summary" reply is Markdown).
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let page: Page;
let diagramId = '';

const assistant = () => page.locator('[data-testid="chat-message-assistant"]');
const user = () => page.locator('[data-testid="chat-message-user"]');

async function openChat() {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('rail-tab-chat').click();
  await expect(page.getByTestId('chat-input')).toBeVisible();
  // Count replies only once the history is in (canvas-eaj).
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-history-loaded', 'true');
}

async function send(text: string) {
  const before = await assistant().count();
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
  await expect(assistant()).toHaveCount(before + 1);
  return assistant().nth(before);
}

async function a11y() {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function expectFormattedSummary(bubble: ReturnType<Page['locator']>) {
  await expect(bubble.locator('strong', { hasText: 'summary' })).toHaveCount(1);
  const items = bubble.locator('ul li');
  await expect(items).toHaveCount(2);
  await expect(bubble.locator('code', { hasText: 'inline code' })).toHaveCount(1);
  const pre = bubble.locator('pre');
  await expect(pre).toHaveCount(1);
  await expect(pre).toContainText('flowchart TD');
  await expect(pre).toContainText('A --> B');
  // Raw HTML in the reply is shown as text, never turned into an element.
  await expect(bubble).toContainText('<b>this</b>');
  await expect(bubble.locator('b')).toHaveCount(0);
  const link = bubble.locator('a[href="https://example.com/docs"]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('target', '_blank');
  expect(await link.getAttribute('rel')).toContain('noopener');
  // No leftover Markdown syntax.
  const text = (await bubble.innerText()) ?? '';
  expect(text).not.toContain('**');
  expect(text).not.toMatch(/^- /m);
  expect(text).not.toContain('```');
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
  const created = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: { name: `Chat formatting ${Date.now()}`, diagramTypeId: 'flowchart' },
  });
  expect(created.status()).toBe(201);
  diagramId = (await created.json()).diagram.id;
});

test.afterAll(async () => {
  await page?.context().close();
});

test('a Markdown reply renders as formatted text, and raw HTML stays text', async () => {
  await openChat();
  const bubble = await send('show a formatted summary');
  await expectFormattedSummary(bubble);
  await expect(bubble.locator('.chat-markdown')).toBeVisible();
  await a11y();
});

test('edits made and edits that could not be made appear in a separate note', async () => {
  await openChat();
  const ok = await send('Add a shape called Formatted');
  await expect(ok.getByTestId('chat-edits-applied')).toHaveText('1 change made to the diagram');
  await expect(ok.getByTestId('chat-edits-failed')).toHaveCount(0);

  const failed = await send('Remove the shape called Ghost');
  const item = failed.getByTestId('chat-edits-failed');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Couldn’t make a change:');
  const reason = ((await item.textContent()) ?? '').replace('Couldn’t make a change:', '').trim();
  expect(reason.length).toBeGreaterThan(3);
  // The reason lives in the edit note, not in the reply's own text.
  const replyText = (await failed.locator('.chat-markdown').innerText()) ?? '';
  expect(replyText).not.toContain(reason);
  await expect(failed.getByTestId('chat-edits-applied')).toHaveCount(0);
  await a11y();
});

test('a multi-line user message keeps its line breaks', async () => {
  await openChat();
  await page.getByTestId('chat-input').fill('first line\nsecond line\nthird line');
  await page.getByTestId('chat-send').click();
  const bubble = user().last();
  await expect(bubble).toContainText('third line');
  const text = (await bubble.locator('.chat-bubble__text').innerText()) ?? '';
  expect(text.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['first line', 'second line', 'third line']);
  await expect(assistant().last()).toBeVisible();
});

test('history renders formatted after a reload', async () => {
  await openChat();
  await expect(assistant().first()).toBeVisible();
  const summary = assistant().filter({ has: page.locator('pre') }).first();
  await expectFormattedSummary(summary);
  await expect(page.getByTestId('chat-edits-applied').first()).toHaveText('1 change made to the diagram');
  await expect(page.getByTestId('chat-edits-failed').first()).toBeVisible();
});

// canvas-eaj: Send used to work before the conversation history had loaded, so a slow history
// response raced the reply -- replacing it, or (fetched after the turn was stored) adding it a
// second time. Slowing the history request makes that race certain; Send must wait for it.
test('Send waits for the history to load, so one message gives exactly one reply', async () => {
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => (releaseHistory = resolve));
  await page.route(`**/diagrams/${diagramId}/chat/messages`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await historyGate;
    await route.continue();
  });
  try {
    await page.goto(`/?diagramId=${diagramId}`);
    await expect(page.getByTestId('diagram-canvas')).toBeVisible();
    await page.getByTestId('rail-tab-chat').click();
    await page.getByTestId('chat-input').fill('show a formatted summary');
    await expect(page.getByTestId('chat-send')).toBeDisabled(); // history still loading
    releaseHistory();
    await expect(page.getByTestId('chat-send')).toBeEnabled();
    const before = await assistant().count();
    await page.getByTestId('chat-send').click();
    await expect(assistant()).toHaveCount(before + 1);
    await page.waitForTimeout(1500); // a late duplicate would land here
    await expect(assistant()).toHaveCount(before + 1);
    await expectFormattedSummary(assistant().nth(before));
  } finally {
    await page.unroute(`**/diagrams/${diagramId}/chat/messages`);
  }
});

test('the Create with AI dialog transcript renders replies inside .chat-markdown', async () => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('create-via-ai-chat').click();
  await page.getByTestId('ai-create-persona').selectOption({ label: 'Business Architect' });
  await page.getByTestId('ai-create-description').fill('Create a diagram');
  await page.getByTestId('ai-create-confirm').click();
  const reply = page.getByTestId('create-chat-assistant').last();
  await expect(reply).toBeVisible();
  await expect(reply.locator('.chat-markdown')).toBeVisible();
  expect((((await reply.innerText()) ?? '').trim()).length).toBeGreaterThan(10);
  await page.getByTestId('ai-create-cancel').click();
});

test('the chat panel with a formatted reply fits a 390px screen', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat();
  await expect(assistant().first()).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  await page.setViewportSize({ width: 1280, height: 900 });
});
