import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 3 (feature 004) end-to-end: an admin creates, edits, and archives a persona, and
 * each change is immediately reflected in the chat's persona dropdown; a non-admin cannot reach
 * the persona admin screen at all (spec.md acceptance scenario 5).
 */
test('admin manages the persona library; a non-admin cannot reach the screen', async ({ page }) => {
  const personaName = `E2E Persona ${Date.now()}`;

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('admin-ai-personas-link').click();
  await expect(page.getByTestId('persona-create-submit')).toBeVisible();

  // Turn AI chat on from the same screen (FR-020's admin toggle).
  await page.getByTestId('ai-chat-enabled-toggle').check();

  // Create a persona under "Enterprise" and confirm it's listed, grouped under that category.
  await page.getByTestId('persona-create-name').fill(personaName);
  await page.getByTestId('persona-create-category').selectOption('Enterprise');
  await page.getByTestId('persona-create-prompt').fill('You are an enterprise architect for E2E testing.');
  await page.getByTestId('persona-create-submit').click();
  await expect(page.getByText(personaName)).toBeVisible();

  // It appears immediately in the chat's persona dropdown, grouped under "Enterprise".
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('create-via-ai-chat').click();
  const personaSelect = page.getByTestId('ai-create-persona');
  await expect(personaSelect.locator('optgroup[label="Enterprise"] option', { hasText: personaName })).toHaveCount(1);
  await page.getByTestId('ai-create-cancel').click();

  // Edit the persona's system prompt; a persisted change confirms via a reload (state comes
  // straight from the API, not React state alone).
  await page.getByTestId('admin-ai-personas-link').click();
  const row = page.locator('li', { has: page.locator('strong', { hasText: personaName }) });
  const rowPrompt = row.locator('textarea');
  await rowPrompt.fill('Updated E2E system prompt.');
  await rowPrompt.blur();
  await page.reload();
  const reloadedRow = page.locator('li', { has: page.locator('strong', { hasText: personaName }) });
  await expect(reloadedRow.locator('textarea')).toHaveValue('Updated E2E system prompt.');

  // Archive it: by default (canvas-rbu) the row disappears from the list entirely, since
  // archived entries are hidden unless explicitly shown.
  await reloadedRow.locator('button', { hasText: 'Archive' }).click();
  await expect(page.locator('li', { has: page.locator('strong', { hasText: personaName }) })).toHaveCount(0);

  // The "Show archived" toggle reveals it again, with the "archived" status badge and no
  // Archive action (it's already archived).
  await page.getByTestId('show-archived-personas-toggle').check();
  const archivedRow = page.locator('li', { has: page.locator('strong', { hasText: personaName }) });
  await expect(archivedRow.locator('[data-testid^="persona-status-"]')).toContainText('archived');
  await expect(archivedRow.locator('button', { hasText: 'Archive' })).toHaveCount(0);

  // Unchecking hides it again.
  await page.getByTestId('show-archived-personas-toggle').uncheck();
  await expect(page.locator('li', { has: page.locator('strong', { hasText: personaName }) })).toHaveCount(0);

  // It no longer appears in the chat dropdown for new chats.
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('create-via-ai-chat').click();
  await expect(page.getByTestId('ai-create-persona').locator('option', { hasText: personaName })).toHaveCount(0);
  await page.getByTestId('ai-create-cancel').click();

  await page.getByTestId('sign-out').click();

  // A non-admin visiting the same URL sees the ordinary main screen, not the persona admin UI —
  // consistent with the platform's other admin-only screens.
  await page.getByTestId('login-email').fill(ARCHITECT_EMAIL);
  await page.getByTestId('login-password').fill(ARCHITECT_PASSWORD);
  await page.getByTestId('login-submit').click();
  // waitForURL is a no-op in this SPA (the URL never changes on login) — wait for the
  // post-login signal itself before navigating away, or the goto below can race the still
  // in-flight login request.
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await page.goto(`/?projectId=${PROJECT_ID}&admin=ai-personas`);
  await expect(page.getByTestId('persona-create-submit')).toHaveCount(0);
  await expect(page.getByTestId('new-diagram')).toBeVisible();
});
