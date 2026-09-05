import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * 010-ai-diagram-knowledge, T010 (User Story 1): before this feature, `diagram-chat.service.ts`
 * hardcoded `getDslFamily('flowchart')` regardless of the diagram's real type — a confirmed live
 * bug (research.md §1) — so sending a chat message against any non-flowchart diagram threw a 422
 * and the request failed outright, even though the chat panel was shown for every diagram type.
 * This test exercises the real dev-server + mock-NLU pipeline (apps/api/src/ai/mock-nlu.ts,
 * AI_PROVIDER=mock) against an ER diagram specifically, using only the pre-existing, already
 * diagram-type-agnostic rename rule — no mock-nlu changes needed for this story.
 */
test('renames an entity via chat on an ER diagram without error or corruption', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-erd').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('erDiagram\n  CUSTOMER {\n    string name\n  }\n  ORDER {\n    string id\n  }\n  CUSTOMER ||--o{ ORDER : places\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  await page.getByTestId('chat-input').fill('Rename CUSTOMER to Client');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(1);

  // No error surfaced, and the diagram is still valid, correctly-typed ER syntax — not silently
  // corrupted or misread as flowchart (the bug this story fixes).
  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('erDiagram');
  expect(dsl).toContain('Client');
  expect(dsl).toContain('ORDER');
  expect(dsl).toContain('places');
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
});

/**
 * 010-ai-diagram-knowledge, T022 (User Story 2): the six spec acceptance scenarios, each pre-
 * authoring its diagram's DSL directly (mirroring the T010 test above), sending exactly one chat
 * message that should trigger exactly one of the new family-scoped AI tools
 * (apps/api/src/ai/diagram-tools.ts), then asserting the resulting DSL shows the real,
 * family-correct structure — not a generic labeled box.
 */

async function loginAndEnableChat(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
}

test('adds an ER attribute via chat', async ({ page }) => {
  await loginAndEnableChat(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-erd').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('erDiagram\n  CUSTOMER {\n    string name\n  }\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  await page.getByTestId('chat-input').fill('Give CUSTOMER an attribute string id PK');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(1);

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('erDiagram');
  expect(dsl).toContain('CUSTOMER');
  // setEntityAttributes replaces an entity's attribute list wholesale (diagram-ops.ts's own
  // documented "an attribute list is naturally replace-whole" convention) — the one attribute
  // supplied in this request is what should now be present, not merged with the pre-existing one.
  expect(dsl).toMatch(/string id PK/);
});

test('adds a UML class member and sets a relationship kind via chat', async ({ page }) => {
  await loginAndEnableChat(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-uml').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('classDiagram\n  class Order\n  class Customer\n  Order --> Customer\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');

  await page.getByTestId('chat-input').fill('Give Order a private string id attribute and a public place method');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(1);

  await page.getByTestId('rail-tab-dsl').click();
  let dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toMatch(/-string id/);
  expect(dsl).toMatch(/\+place\(\)/);

  await page.getByTestId('rail-tab-chat').click();
  await page.getByTestId('chat-input').fill('Make the connector between Order and Customer a composition');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(2);

  await page.getByTestId('rail-tab-dsl').click();
  dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toMatch(/Order\s*\*--\s*Customer/);
});

test('sets a C4 element role via chat', async ({ page }) => {
  await loginAndEnableChat(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-c4-context').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('C4Context\n  Container(sys, "Sys", "desc")\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(1);

  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  await page.getByTestId('chat-input').fill('Set the role of Sys to system');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(1);

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toMatch(/System\(sys,/);
  expect(dsl).not.toMatch(/Container\(sys,/);
});

test('activates a sequence participant via chat', async ({ page }) => {
  await loginAndEnableChat(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-sequence').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('sequenceDiagram\n  participant Alice\n  participant Bob\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  await page.getByTestId('chat-input').fill('Activate Bob');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(1);

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('activate Bob');
});

test('groups architecture services into a container via chat', async ({ page }) => {
  await loginAndEnableChat(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-cloud-infrastructure').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  await page.getByTestId('dsl-panel').fill('architecture-beta\n  service api(cloud)[API]\n  service db(cloud)[DB]\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  await page.getByTestId('chat-input').fill('Group API and DB into a container called Backend');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(1);

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  const groupLineMatch = dsl.match(/^group (\S+)\(cloud\)\[Backend\]$/m);
  expect(groupLineMatch).not.toBeNull();
  const groupId = groupLineMatch![1];
  expect(dsl).toMatch(new RegExp(`service api\\(cloud\\)\\[API\\] in ${groupId}`));
  expect(dsl).toMatch(new RegExp(`service db\\(cloud\\)\\[DB\\] in ${groupId}`));
});

test('declines a UML-only edit request on a flowchart diagram (no equivalent tool offered)', async ({ page }) => {
  await loginAndEnableChat(page);

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const originalDsl = 'flowchart TD\n  A[Alpha] --> B[Beta]\n';
  await page.getByTestId('dsl-panel').fill(originalDsl);
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  // Same phrasing as the UML relationship-kind scenario above — but `setRelationshipKind` isn't
  // offered for the flowchart family, so there's no tool call this rule can return (FR-004): the
  // mock model falls through to its plain decline text, not a tool that silently ran and no-oped.
  await page.getByTestId('chat-input').fill('Make the connector between Alpha and Beta a composition');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(1);
  await expect(assistantMessages.first()).toContainText("I'm not sure how to help with that.");

  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  expect(dsl).toContain('flowchart TD');
  expect(dsl).toContain('A[Alpha]');
  expect(dsl).toContain('B[Beta]');
  expect(dsl).toMatch(/A\s*-->\s*B/);
  expect(dsl).not.toMatch(/\*--/);
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
});
