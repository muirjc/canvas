import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function dragNodeBy(page: Page, testId: string, dx: number, dy: number) {
  const target = page.getByTestId(testId);
  // page.mouse is a raw, unscrolling API (unlike .click()/.fill()) — earlier chat interactions
  // can scroll the page enough to move this node out of the viewport first.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${testId} has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
  await page.mouse.up();
}

async function sendChatMessage(page: Page, message: string) {
  // The editor's secondary rail shows one panel at a time (feature 005), so select Chat first.
  // Navigation only — no assertion in this file changed.
  await page.getByTestId('rail-tab-chat').click();
  const assistantMessages = page.locator('[data-testid="chat-message-assistant"]');
  const before = await assistantMessages.count();
  await page.getByTestId('chat-input').fill(message);
  await page.getByTestId('chat-send').click();
  // Wait for the turn to complete before the caller inspects the result or sends another
  // message — a new assistant bubble appearing is the signal, since the input clears (and its
  // "disabled while empty" state) regardless of whether the request already finished.
  await expect(assistantMessages).toHaveCount(before + 1);
}

/** Reads a node's persisted canvas position straight out of the DSL panel's YAML front-matter
 * (packages/diagram-core/src/dsl/front-matter.ts) — the actual thing FR-011/FR-012 promises is
 * preserved, unlike a screen-pixel bounding box, which shifts with page scroll (e.g. Playwright
 * auto-scrolling the chat input into view) even though nothing about the model moved. */
function extractPosition(dsl: string, nodeId: string): { x: number; y: number } | undefined {
  const match = dsl.match(new RegExp(`${nodeId}:\\s*\\n\\s*x:\\s*(-?[0-9.]+)\\s*\\n\\s*y:\\s*(-?[0-9.]+)`));
  if (!match) return undefined;
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function getDslPosition(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  // Select the DSL panel before reading it — this spec interleaves DSL reads with chat sends,
  // and the rail shows one panel at a time (feature 005). Navigation only.
  await page.getByTestId('rail-tab-dsl').click();
  const dsl = await page.getByTestId('dsl-panel').inputValue();
  const position = extractPosition(dsl, nodeId);
  if (!position) throw new Error(`no canvas position found for ${nodeId} in DSL:\n${dsl}`);
  return position;
}

/**
 * User Story 2 (feature 004) end-to-end, against the API's `AI_PROVIDER=mock` rule-based fake
 * NLU (apps/api/src/ai/mock-nlu.ts) — no real LLM call. Requires the API dev server to have been
 * started with AI_PROVIDER=mock (see RUNBOOK.md).
 *
 * Covers spec.md User Story 2's acceptance scenarios: chat-driven add/connect/rename/remove each
 * affect only their target; a manually-dragged shape's position survives unrelated chat edits;
 * manual and chat edits alternate freely; and a chat request naming a nonexistent element is
 * reported back without changing the diagram.
 */
test('refines an open diagram through chat without disturbing manual edits', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  // AI chat is off by default (FR-020); its admin toggle UI doesn't exist yet (User Story 3).
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  // Seed two known-id shapes directly via the DSL panel — deterministic ids make the later
  // chat-driven "connect/rename/remove by name" steps and position checks reliable.
  await page.getByTestId('dsl-panel').fill('flowchart TD\n  validate[Validate]\n  approve[Approve]\n');
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);

  // Manually reposition "Validate" — this position must survive every chat edit that follows
  // (acceptance scenario 3).
  const validateBeforeDrag = await getDslPosition(page, 'validate');
  await dragNodeBy(page, 'node-validate', 120, 80);
  const validateAfterDrag = await getDslPosition(page, 'validate');
  expect(validateAfterDrag).not.toEqual(validateBeforeDrag);

  // Chat-driven add: a new shape appears, nothing else moves (scenarios 1 & 3).
  await sendChatMessage(page, 'Add a shape called Reject');
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(3);
  await expect(page.getByTestId('dsl-panel')).toContainText('Reject');
  expect(await getDslPosition(page, 'validate')).toEqual(validateAfterDrag);

  // Chat-driven connect, by shape name rather than id.
  await sendChatMessage(page, 'Connect Approve to Reject');
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(1);

  // Chat-driven rename affects only the named shape.
  await sendChatMessage(page, 'Rename Reject to Rejected');
  await expect(page.getByTestId('dsl-panel')).toContainText('Rejected');
  await expect(page.getByTestId('dsl-panel')).toContainText('Validate');
  await expect(page.getByTestId('dsl-panel')).toContainText('Approve');

  // Alternate back to a manual edit (scenario 4) — reposition "Approve" too.
  const approveBeforeDrag = await getDslPosition(page, 'approve');
  await dragNodeBy(page, 'node-approve', -60, 100);
  const approveAfterDrag = await getDslPosition(page, 'approve');
  expect(approveAfterDrag).not.toEqual(approveBeforeDrag);

  // Chat-driven remove affects only the named shape; both manual repositions still hold.
  await sendChatMessage(page, 'Remove shape called Approve');
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
  await expect(page.getByTestId('dsl-panel')).not.toContainText('Approve');
  expect(await getDslPosition(page, 'validate')).toEqual(validateAfterDrag);

  // Chat request naming an element that no longer exists (Approve was just removed): the chat
  // reports it, the diagram is unchanged (scenario 5, FR-014).
  await sendChatMessage(page, 'Remove shape called Approve');
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="chat-message-assistant"]').last()).toContainText('No shape with id');
});
