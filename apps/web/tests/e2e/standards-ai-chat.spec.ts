import { expect, test } from '@playwright/test';
import { API_BASE_URL, PROJECT_ID, login, newDiagram, readDsl } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

// Relies on the API's AI_PROVIDER=mock rule-based NLU (apps/api/src/ai/mock-nlu.ts).
test('chat: "add a primary_activity called Operations" creates a kind-styled node', async ({ page }) => {
  await login(page);
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
  await newDiagram(page, 'value-chain');

  await page.getByTestId('rail-tab-chat').click();
  await page.getByTestId('chat-input').fill('add a primary_activity called Operations');
  await page.getByTestId('chat-send').click();
  await expect(page.locator('[data-testid="chat-message-assistant"]')).toHaveCount(1);

  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  const node = page.locator('[data-testid^="node-"]').first();
  await expect(node).toContainText('Operations');
  await expect(node.locator('path, polygon, rect').first()).toHaveAttribute('fill', /#dbeafe/i);
  const dsl = await readDsl(page);
  expect(dsl).toContain(':::primary_activity');
  expect(dsl).toContain('Operations');
});
