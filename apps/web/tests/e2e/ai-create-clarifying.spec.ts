import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-ltm: "Create with AI" follow-up questions. Written against the API's AI_PROVIDER=mock
 * rule-based NLU (apps/api/src/ai/mock-nlu.ts): a vague "Create a ... diagram" request gets a
 * question instead of tool calls; "Add a shape called X" / "go ahead and draw" draw.
 */
const VAGUE = 'Create a diagram of our order process';
const QUESTION = 'Before I draw this, what are the main steps or elements you want included?';

async function openDialog(page: Page, name: string) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
  await page.getByTestId('create-via-ai-chat').click();
  await expect(page.getByRole('dialog', { name: 'Create via AI Chat' })).toBeVisible();
  await page.getByTestId('ai-create-name').fill(name);
}

async function startConversation(page: Page, name: string) {
  await openDialog(page, name);
  await page.getByTestId('ai-create-persona').selectOption({ label: 'Business Architect' });
  await page.getByTestId('ai-create-type').selectOption('flowchart');
  await page.getByTestId('ai-create-description').fill(VAGUE);
  await page.getByTestId('ai-create-confirm').click();
  await expect(page.getByTestId('create-chat-assistant')).toContainText(QUESTION);
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);
}

test('a vague request gets a follow-up question; the answer draws, opens the Chat tab, and is auto-saved', async ({ page }) => {
  const name = `Clarify ${Date.now()}`;
  await startConversation(page, name);

  await page.getByTestId('ai-create-answer').fill('Add a shape called Order Received');
  await page.getByTestId('ai-create-answer-send').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('rail-tab-chat')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="chat-message-user"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="chat-message-assistant"]').first()).toContainText(QUESTION);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  // Reopen from the project browser: the node was persisted, not only held in client state.
  await page.getByTestId('back-to-diagrams').click();
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await page.locator('li', { hasText: name }).locator('[data-testid^="open-diagram-"]').first().click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  await page.getByTestId('rail-tab-dsl').click();
  await expect(page.getByTestId('dsl-panel')).toContainText('Order Received');
});

test('"Just draw it" draws a placeholder and opens the editor', async ({ page }) => {
  await startConversation(page, `JustDraw ${Date.now()}`);
  await page.getByTestId('ai-create-draw-now').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('rail-tab-dsl').click();
  await expect(page.getByTestId('dsl-panel')).toContainText('Draft step');
});

test('cancelling mid-conversation removes the empty diagram', async ({ page }) => {
  const name = `CancelMe ${Date.now()}`;
  await startConversation(page, name);
  await page.getByTestId('ai-create-cancel').click();
  await expect(page.getByRole('dialog', { name: 'Create via AI Chat' })).toHaveCount(0);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);
  // Not just hidden by stale client state: a fresh load of the browser still lacks it.
  await page.reload();
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);
});

test('the type picker creates a Value Chain diagram directly, with the standard\'s element kind', async ({ page }) => {
  await openDialog(page, `VC ${Date.now()}`);
  await page.getByTestId('ai-create-persona').selectOption({ label: 'Business Architect' });
  await page.getByTestId('ai-create-type').selectOption('value-chain');
  await page.getByTestId('ai-create-description').fill('add a primary_activity called Operations');
  await page.getByTestId('ai-create-confirm').click();

  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  // Opens on Chat (the AI's reply is there), even without a conversation.
  await expect(page.getByTestId('rail-tab-chat')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('rail-tab-dsl').click();
  await expect(page.getByTestId('dsl-panel')).toContainText(':::primary_activity');
});
