import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-f9q: only "Create via AI Chat" ever collected a persona — a hand-created or imported
 * diagram's chat was permanently stuck on the default assistant prompt with no UI path to ever
 * set one (FR-008a fixes the persona at the diagram's first chat message). ChatPanel now offers
 * the same persona picker before that first message, for any diagram, regardless of how it was
 * created.
 */
test('offers a persona picker before the first chat message on a hand-created diagram', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  // AI chat is off by default (FR-020); its admin toggle UI is on the persona admin screen.
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  // Hand-created via plain "New Diagram" — never touches CreateViaChatDialog, so this diagram's
  // chat has never had any persona-selection UI at all before this fix.
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('rail-tab-chat').click();
  const personaSelect = page.getByTestId('chat-persona-select');
  await expect(personaSelect).toBeVisible();
  // Same optgroup-by-category shape as ai-create-persona (CreateViaChatDialog).
  await expect(personaSelect.locator('optgroup[label="Business"] option')).not.toHaveCount(0);
  await personaSelect.selectOption({ label: 'Business Architect' });

  // The selected persona is passed through as personaId on this diagram's first sendChatMessage
  // call — FR-008a's fixed-at-first-message contract, wired end to end rather than only rendered.
  const [request] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/chat/messages') && req.method() === 'POST'),
    page.getByTestId('chat-input').fill('Add a shape called Kickoff').then(() => page.getByTestId('chat-send').click()),
  ]);
  const personaIdSent = (request.postDataJSON() as { personaId?: string }).personaId;
  expect(personaIdSent).toBeTruthy();

  await expect(page.locator('[data-testid="chat-message-assistant"]')).toHaveCount(1);
  // Once a first message exists, the choice is already fixed (FR-008a) — offering it again would
  // suggest a choice that no longer does anything.
  await expect(personaSelect).toHaveCount(0);
});

test('a diagram with existing chat history never shows the persona picker', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  await page.getByTestId('create-via-ai-chat').click();
  await page.getByTestId('ai-create-persona').selectOption({ label: 'Business Architect' });
  await page.getByTestId('ai-create-description').fill('Add a shape called Kickoff');
  await page.getByTestId('ai-create-confirm').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('rail-tab-chat').click();
  await expect(page.locator('[data-testid="chat-message-user"]')).toHaveCount(1);
  await expect(page.getByTestId('chat-persona-select')).toHaveCount(0);
});
