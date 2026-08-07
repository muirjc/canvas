import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page, email: string, password: string, url: string) {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

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

  // Edit the persona's system prompt via the explicit Save action (canvas-ddx) — blur alone no
  // longer commits. A persisted change confirms via a reload (state comes straight from the API,
  // not React state alone).
  await page.getByTestId('admin-ai-personas-link').click();
  const row = page.locator('li', { has: page.locator('strong', { hasText: personaName }) });
  const rowPrompt = row.locator('textarea');
  const rowSave = row.locator('[data-testid^="persona-prompt-save-"]');
  await expect(rowSave).toBeDisabled();
  await rowPrompt.fill('Updated E2E system prompt.');
  await expect(row.locator('[data-testid^="persona-prompt-status-"]')).toHaveText('Unsaved changes');
  await expect(rowSave).toBeEnabled();
  await rowSave.click();
  await expect(row.locator('[data-testid^="persona-prompt-status-"]')).toHaveText('Saved');
  await expect(rowSave).toBeDisabled();

  // Starting a NEW edit clears the stale "Saved" status rather than leaving it lingering next to
  // an input that no longer matches what was actually saved.
  await rowPrompt.fill('Updated E2E system prompt, take two — never saved.');
  await expect(row.locator('[data-testid^="persona-prompt-status-"]')).toHaveText('Unsaved changes');
  await expect(rowSave).toBeEnabled();

  // That second edit is never saved. A reload (a real GET, not just React state) proves it never
  // reached the backend — the persisted value is still the FIRST save, not this second unsaved one.
  await page.reload();
  const reloadedRow = page.locator('li', { has: page.locator('strong', { hasText: personaName }) });
  await expect(reloadedRow.locator('textarea')).toHaveValue('Updated E2E system prompt.');
  await expect(reloadedRow.locator('[data-testid^="persona-prompt-save-"]')).toBeDisabled();

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

/**
 * canvas-ddx: each persona's Save button/dirty state is derived purely from that persona's own
 * `drafts` entry — confirms editing one persona's textarea can't leak dirty/enabled state onto a
 * sibling's Save button. Uses two of the always-seeded one-per-category personas (Business
 * Architect, Enterprise Architect) so no extra persona creation is needed; neither Save button is
 * ever clicked, so this never mutates seeded persona data.
 */
test('editing one persona\'s prompt does not affect another persona\'s save state', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=ai-personas');

  const rowA = page.locator('li', { has: page.locator('strong', { hasText: 'Business Architect' }) });
  const rowB = page.locator('li', { has: page.locator('strong', { hasText: 'Enterprise Architect' }) });
  const saveA = rowA.locator('[data-testid^="persona-prompt-save-"]');
  const saveB = rowB.locator('[data-testid^="persona-prompt-save-"]');

  await expect(saveA).toBeDisabled();
  await expect(saveB).toBeDisabled();

  await rowA.locator('textarea').fill('Independent edit for Business Architect only — never saved.');
  await expect(saveA).toBeEnabled();
  await expect(rowA.locator('[data-testid^="persona-prompt-status-"]')).toHaveText('Unsaved changes');

  // Persona B is untouched: still disabled, and no stray "Unsaved changes"/"Saved" status renders
  // for it at all (the status span only renders when dirty or just-saved — see PersonaAdminPage).
  await expect(saveB).toBeDisabled();
  await expect(rowB.locator('[data-testid^="persona-prompt-status-"]')).toHaveCount(0);
});
