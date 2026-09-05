import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/**
 * 010-ai-diagram-knowledge, T034 (User Story 4): an admin attaches a reference-material entry
 * scoped to the ERD family to the (always-seeded) Technical Architect persona; a chat on an ERD
 * diagram using that persona should surface the entry's content (via mock-nlu.ts's "What do you
 * know about this diagram?" introspection rule, which echoes the composed system prompt back
 * verbatim), while a chat on a non-matching family (UML) using the SAME persona should not.
 */
test('reference-material entries are scoped to their diagram family in chat, and only admins can manage them', async ({
  page,
}) => {
  const marker = `E2E-ERD-REFMAT-${Date.now()}`;

  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  await page.getByTestId('admin-ai-personas-link').click();
  await expect(page.getByTestId('persona-create-submit')).toBeVisible();

  const technicalRow = page.locator('li', { has: page.locator('strong', { hasText: 'Technical Architect' }) });
  const personaId = await technicalRow.getAttribute('data-testid').then((v) => v!.replace('persona-row-', ''));

  // Add a reference-material entry scoped ONLY to the erd family, with distinctive content.
  await technicalRow.getByTestId(`reference-material-create-content-${personaId}`).fill(
    `Reference fact for testing: ${marker} — always mention the "orders" entity's audit trail.`,
  );
  await technicalRow.getByTestId(`reference-material-create-family-${personaId}-erd`).check();
  await technicalRow.getByTestId(`reference-material-create-submit-${personaId}`).click();

  const newRow = page.locator('[data-testid^="reference-material-row-"]', { hasText: marker });
  await expect(newRow).toBeVisible();

  // ERD diagram, same persona: the introspection reply should contain the ERD-scoped fact.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-erd').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('erDiagram\n  CUSTOMER {\n    string name\n  }\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('rail-tab-chat').click();
  await page.getByTestId('chat-persona-select').selectOption({ label: 'Technical Architect' });
  const erdAssistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  await page.getByTestId('chat-input').fill('What do you know about this diagram?');
  await page.getByTestId('chat-send').click();
  await expect(erdAssistantMessages).toHaveCount(1);
  await expect(erdAssistantMessages.first()).toContainText(marker);

  // UML diagram, SAME persona: the ERD-scoped entry must NOT leak into this family's chat.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-uml').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('classDiagram\n  class Order\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('rail-tab-chat').click();
  await page.getByTestId('chat-persona-select').selectOption({ label: 'Technical Architect' });
  const umlAssistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  await page.getByTestId('chat-input').fill('What do you know about this diagram?');
  await page.getByTestId('chat-send').click();
  await expect(umlAssistantMessages).toHaveCount(1);
  await expect(umlAssistantMessages.first()).not.toContainText(marker);

  await page.getByTestId('sign-out').click();

  // A non-admin cannot reach any reference-material (or persona-create) controls at all.
  await signIn(page, ARCHITECT_EMAIL, ARCHITECT_PASSWORD);
  await page.goto(`/?projectId=${PROJECT_ID}&admin=ai-personas`);
  await expect(page.getByTestId('persona-create-submit')).toHaveCount(0);
  await expect(page.locator('[data-testid^="reference-material-"]')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
});
