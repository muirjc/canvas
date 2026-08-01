import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-kwa: the AI could create/rename/connect/remove elements but had no tool to color them,
 * even though NodeStyle (fillColor/strokeColor/strokeWidth/strokeDasharray) is a full model field
 * already expressible via DSL (style/classDef/linkStyle). Against the API's `AI_PROVIDER=mock`
 * rule-based fake NLU (apps/api/src/ai/mock-nlu.ts — no real LLM call), which now recognizes
 * "make X <color>" and calls the new updateNodeStyle tool.
 */
test('asking the AI to color a shape sets its fill color', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  // AI chat is off by default (FR-020).
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('flowchart TD\n  approved[Approved]\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('rail-tab-chat').click();
  await page.getByTestId('chat-input').fill('Make the Approved node green');
  await page.getByTestId('chat-send').click();
  await expect(page.locator('[data-testid="chat-message-assistant"]')).toHaveCount(1);

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('#27ae60');
});
