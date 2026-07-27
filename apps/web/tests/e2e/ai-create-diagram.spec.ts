import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 1 (feature 004) end-to-end, against the API's `AI_PROVIDER=mock` rule-based fake
 * NLU (apps/api/src/ai/mock-nlu.ts) rather than a real LLM — the API dev server must have been
 * started with AI_PROVIDER=mock (see RUNBOOK.md) or the AI's reply won't match what this test
 * expects.
 */
test('creates a flowchart diagram from a natural-language description via a chosen persona', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  // AI chat is off by default (FR-020) and its admin toggle UI doesn't exist yet (User Story 3) —
  // enable it directly via the same admin endpoint that toggle will eventually call.
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  await page.getByTestId('create-via-ai-chat').click();
  await expect(page.getByRole('dialog', { name: 'Create via AI Chat' })).toBeVisible();
  await page.getByTestId('ai-create-persona').selectOption({ label: 'Business Architect' });
  await page.getByTestId('ai-create-description').fill('Add a shape called Order Received');
  await page.getByTestId('ai-create-confirm').click();

  // A populated flowchart diagram opens directly in the canvas editor (FR-005/FR-006).
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);
  await expect(page.getByTestId('dsl-panel')).toContainText('Order Received');

  // The AI-created shape is a normal, fully-editable node — same manual rename path as any
  // shape added by hand (feature 002), proving it's not a special read-only element.
  const node = page.locator('[data-testid^="node-"]').first();
  await node.dblclick();
  const nodeInput = page.locator('[data-testid^="node-label-input-"]').first();
  await nodeInput.fill('Renamed by hand');
  await nodeInput.press('Enter');
  await expect(page.getByTestId('dsl-panel')).toContainText('Renamed by hand');
});
