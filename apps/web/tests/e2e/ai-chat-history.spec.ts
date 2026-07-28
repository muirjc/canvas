import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 4 (feature 004) end-to-end, against the API's `AI_PROVIDER=mock` rule-based fake
 * NLU (apps/api/src/ai/mock-nlu.ts). Confirms reopening a diagram that's had chat activity shows
 * its full prior conversation in order, while a diagram with none starts with an empty panel.
 */
test('resumes a diagram\'s prior chat conversation on reopen', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  // AI chat is off by default (FR-020); its admin toggle UI is on the persona admin screen.
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  // Create a diagram via chat — its first exchange is itself chat history.
  await page.getByTestId('create-via-ai-chat').click();
  await page.getByTestId('ai-create-persona').selectOption({ label: 'Business Architect' });
  await page.getByTestId('ai-create-description').fill('Add a shape called Kickoff');
  await page.getByTestId('ai-create-confirm').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  // The rail shows one panel at a time (feature 005) — select Chat. Navigation only.
  await page.getByTestId('rail-tab-chat').click();
  await expect(page.locator('[data-testid="chat-message-user"]')).toHaveCount(1);

  // A follow-up chat message adds a second exchange.
  await page.getByTestId('chat-input').fill('Add a shape called Wrapup');
  await page.getByTestId('chat-send').click();
  await expect(page.locator('[data-testid="chat-message-user"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="chat-message-assistant"]')).toHaveCount(2);

  const userMessagesBeforeReload = await page.locator('[data-testid="chat-message-user"]').allTextContents();

  // Leave the diagram and reopen it — a full navigation, not an in-app "back" action (none
  // exists), matching how other specs (e.g. delete-restore-diagram.spec.ts) reopen a diagram.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('project-browser')).toBeVisible();
  // Diagrams are listed newest-first, so the one just created via chat is always the first match.
  await page.locator('[data-testid^="open-diagram-"]').first().click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // The rail shows one panel at a time (feature 005) — select Chat. Navigation only.
  await page.getByTestId('rail-tab-chat').click();
  await expect(page.locator('[data-testid="chat-message-user"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="chat-message-assistant"]')).toHaveCount(2);
  expect(await page.locator('[data-testid="chat-message-user"]').allTextContents()).toEqual(userMessagesBeforeReload);

  // A diagram that's never been chatted with (hand-created here) starts with an empty panel.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  // The rail shows one panel at a time (feature 005) — select Chat. Navigation only.
  await page.getByTestId('rail-tab-chat').click();
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await expect(page.locator('[data-testid^="chat-message-"]')).toHaveCount(0);
});
