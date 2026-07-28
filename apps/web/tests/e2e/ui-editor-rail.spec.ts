import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function openNewDiagram(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/**
 * User Story 2 (feature 005): the secondary rail contract, from
 * specs/005-modern-ui-redesign/contracts/ui-contract.md §4.
 *
 * The mount/keep-alive assertions here are the ones that matter most: unmounting an inactive
 * panel would silently discard an unsent chat message, which is a data-loss-shaped bug that no
 * other test in the suite would notice.
 */
test('document actions and the canvas are visible without scrolling', async ({ page }) => {
  await openNewDiagram(page);

  // FR-009: all document-level actions live in the persistent bar.
  await expect(page.getByTestId('doc-bar')).toBeVisible();
  for (const id of ['save-diagram', 'save-status', 'open-share-dialog']) {
    await expect(page.getByTestId(id)).toBeInViewport();
  }

  // FR-010: the canvas is the largest region of the editor.
  const canvasBox = await page.getByTestId('canvas-surface').boundingBox();
  const leftBox = await page.locator('.editor__rail-left').boundingBox();
  const rightBox = await page.locator('.editor__rail-right').boundingBox();
  expect(canvasBox!.width).toBeGreaterThan(leftBox!.width);
  expect(canvasBox!.width).toBeGreaterThan(rightBox!.width);
});

test('DSL is the default panel and exactly one panel shows at a time', async ({ page }) => {
  await openNewDiagram(page);

  // FR-012: DSL on every open — not the last-used panel.
  await expect(page.getByTestId('rail-tab-dsl')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('dsl-panel')).toBeVisible();

  // A panel never selected is absent from the DOM entirely (lazy mount).
  await expect(page.getByTestId('chat-panel')).toHaveCount(0);
  await expect(page.getByTestId('version-history')).toHaveCount(0);

  await page.getByTestId('rail-tab-chat').click();
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await expect(page.getByTestId('dsl-panel')).not.toBeVisible();
  await expect(page.getByTestId('rail-tab-chat')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('rail-tab-dsl')).toHaveAttribute('aria-selected', 'false');
});

test('an unsent chat draft and the conversation survive switching tabs', async ({ page }) => {
  await openNewDiagram(page);
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });

  await page.getByTestId('rail-tab-chat').click();
  await page.getByTestId('chat-input').fill('a draft I have not sent yet');

  // Switch away and back — the panel is hidden, not unmounted, so the draft must persist.
  await page.getByTestId('rail-tab-dsl').click();
  await expect(page.getByTestId('chat-panel')).not.toBeVisible();
  await page.getByTestId('rail-tab-chat').click();

  await expect(page.getByTestId('chat-input')).toHaveValue('a draft I have not sent yet');
});

test('the rail tabs are a real tablist and are keyboard navigable', async ({ page }) => {
  await openNewDiagram(page);

  const tablist = page.getByRole('tablist');
  await expect(tablist).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(4);

  // Arrow-key navigation between tabs, per the WAI-ARIA tabs pattern.
  await page.getByTestId('rail-tab-dsl').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('rail-tab-chat')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('rail-tab-dsl')).toHaveAttribute('aria-selected', 'true');
});

test('the outstanding violation count is visible without opening the violations panel', async ({ page }) => {
  await openNewDiagram(page);

  // Produce a violation without opening the Issues tab: the seeded flowchart standard permits
  // rectangles, so a circle is non-compliant.
  await page.getByTestId('add-shape-circle').click();
  await page.getByTestId('save-diagram').click();
  // Lowercase deliberately: five existing spec files assert this element's text exactly, so the
  // redesign keeps the word as-is and adds the status dot alongside it rather than restyling
  // the text (SC-003).
  await expect(page.getByTestId('save-status')).toHaveText('saved');

  // FR-013: the count is on the tab itself, while DSL is still the active panel.
  await expect(page.getByTestId('rail-tab-dsl')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('rail-tab-issues')).toContainText('1');
});

test('connect mode exposes its active state to assistive technology', async ({ page }) => {
  await openNewDiagram(page);

  // FR-015 — the toggle relocated into the palette rail must keep announcing its state.
  const toggle = page.getByTestId('connect-mode-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('the diagram tools toolbar keeps its role and accessible name after relocating', async ({ page }) => {
  await openNewDiagram(page);
  // contracts/ui-contract.md §2: the role and name travel with the tools into the palette rail.
  await expect(page.getByRole('toolbar', { name: 'Diagram tools' })).toBeVisible();
});
