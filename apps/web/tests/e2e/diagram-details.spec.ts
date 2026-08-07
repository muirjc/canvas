import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const OWNER_EMAIL = 'architect@example.com';
const OWNER_PASSWORD = 'architect-dev-password';
const OWNER_NAME = 'Architect';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-hbk: the doc-bar's new "Diagram details" dialog (`DiagramEditor.tsx`) — owner/created
 * display plus an editable free-text description, following the same controlled-draft +
 * explicit-Save pattern as `PersonaAdminPage.tsx`'s prompt editor (canvas-ddx), whose
 * `ai-persona-admin.spec.ts` coverage of that same status-indicator behavior is this spec's
 * closest style precedent. Backend contract coverage already exists
 * (`apps/api/tests/contract/diagram-description.test.ts`) — this only exercises the UI wiring.
 */

async function signIn(page: Page, email: string, password: string, url = '/'): Promise<void> {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

async function createDiagram(page: Page, projectId: string, name: string): Promise<string> {
  const response = await page.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
    data: { name, diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).diagram.id;
}

async function openDiagram(page: Page, projectId: string, diagramId: string): Promise<void> {
  await page.goto(`/?projectId=${projectId}`);
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(page.getByTestId(`open-diagram-${diagramId}`)).toBeVisible();
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

test('a fresh diagram with no description shows the owner, a plausible created date, an empty textarea, and a disabled Save button', async ({
  page,
}) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Details Fresh ${Date.now()}`;
  const diagramId = await createDiagram(page, PROJECT_ID!, name);
  await openDiagram(page, PROJECT_ID!, diagramId);

  await expect(page.getByTestId('diagram-details')).toHaveCount(0);
  await page.getByTestId('open-diagram-details').click();

  const dialog = page.getByTestId('diagram-details');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('diagram-details-owner')).toHaveText(OWNER_NAME);

  // "Plausible" creation date: parses to a real Date within the last few minutes of test-run time
  // (not asserting an exact string, since toLocaleString() formatting is locale/timezone-dependent).
  const createdText = await dialog.getByTestId('diagram-details-created').innerText();
  const createdMs = Date.parse(createdText);
  expect(Number.isNaN(createdMs)).toBe(false);
  expect(Math.abs(Date.now() - createdMs)).toBeLessThan(5 * 60 * 1000);

  await expect(dialog.getByTestId('diagram-description-input')).toHaveValue('');
  await expect(dialog.getByTestId('diagram-description-save')).toBeDisabled();
  await expect(dialog.getByTestId('diagram-description-status')).toHaveCount(0);
  await expect(dialog.getByTestId('diagram-description-error')).toHaveCount(0);
});

test('typing a description and clicking Save persists it — still there after closing, reopening, and reloading', async ({
  page,
}) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Details Save ${Date.now()}`;
  const diagramId = await createDiagram(page, PROJECT_ID!, name);
  await openDiagram(page, PROJECT_ID!, diagramId);

  await page.getByTestId('open-diagram-details').click();
  const dialog = page.getByTestId('diagram-details');
  const description = 'Describes the checkout approval flow, end to end.';
  await dialog.getByTestId('diagram-description-input').fill(description);
  await dialog.getByTestId('diagram-description-save').click();
  await expect(dialog.getByTestId('diagram-description-status')).toHaveText('Saved');

  // Close and reopen the dialog within the same session — still reflects the saved value.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByTestId('open-diagram-details').click();
  await expect(page.getByTestId('diagram-details').getByTestId('diagram-description-input')).toHaveValue(description);

  // Persisted server-side, not just local React state — confirmed via a full page reload. A
  // reload always lands back on ProjectBrowser (there is no diagram id in the URL to restore),
  // so the diagram has to be reopened, not just re-fetched in place.
  await page.reload();
  await expect(page.getByTestId('sign-out')).toBeVisible();
  await openDiagram(page, PROJECT_ID!, diagramId);
  await page.getByTestId('open-diagram-details').click();
  await expect(page.getByTestId('diagram-details').getByTestId('diagram-description-input')).toHaveValue(description);

  const getResponse = await page.request.get(`${API_BASE_URL}/diagrams/${diagramId}`);
  expect((await getResponse.json()).diagram.description).toBe(description);
});

test('the Unsaved changes / Saved status indicator tracks dirty state correctly', async ({ page }) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Details Status ${Date.now()}`;
  const diagramId = await createDiagram(page, PROJECT_ID!, name);
  await openDiagram(page, PROJECT_ID!, diagramId);

  await page.getByTestId('open-diagram-details').click();
  const dialog = page.getByTestId('diagram-details');
  const input = dialog.getByTestId('diagram-description-input');
  const saveButton = dialog.getByTestId('diagram-description-save');
  const status = dialog.getByTestId('diagram-description-status');

  // Untouched: no status shown at all, Save disabled.
  await expect(status).toHaveCount(0);
  await expect(saveButton).toBeDisabled();

  // Dirty while unsaved.
  await input.fill('First draft.');
  await expect(status).toHaveText('Unsaved changes');
  await expect(saveButton).toBeEnabled();

  // "Saved" immediately after a successful save.
  await saveButton.click();
  await expect(status).toHaveText('Saved');
  await expect(saveButton).toBeDisabled();

  // The instant a new edit starts, the stale "Saved" clears back to "Unsaved changes" rather than
  // lingering next to text that no longer matches what was actually persisted.
  await input.fill('First draft. Now edited again — never saved.');
  await expect(status).toHaveText('Unsaved changes');
  await expect(saveButton).toBeEnabled();
});

test('Escape closes the dialog but keeps the in-progress unsaved draft — it is not lost, and it is not persisted either', async ({
  page,
}) => {
  await signIn(page, OWNER_EMAIL, OWNER_PASSWORD);
  const name = `Details Escape ${Date.now()}`;
  const diagramId = await createDiagram(page, PROJECT_ID!, name);
  await openDiagram(page, PROJECT_ID!, diagramId);

  await page.getByTestId('open-diagram-details').click();
  let dialog = page.getByTestId('diagram-details');
  const draft = 'An in-progress, never-saved draft.';
  await dialog.getByTestId('diagram-description-input').fill(draft);
  await expect(dialog.getByTestId('diagram-description-status')).toHaveText('Unsaved changes');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('diagram-details')).toHaveCount(0);

  // Reopening shows the SAME draft still sitting in the textarea, still marked unsaved —
  // DiagramEditor keeps `descriptionDraft` in its own state, independent of the Modal's mount
  // lifecycle, so closing without saving does not discard it.
  await page.getByTestId('open-diagram-details').click();
  dialog = page.getByTestId('diagram-details');
  await expect(dialog.getByTestId('diagram-description-input')).toHaveValue(draft);
  await expect(dialog.getByTestId('diagram-description-status')).toHaveText('Unsaved changes');
  await expect(dialog.getByTestId('diagram-description-save')).toBeEnabled();

  // But it was genuinely never sent to the server — the diagram still has no description.
  const getResponse = await page.request.get(`${API_BASE_URL}/diagrams/${diagramId}`);
  expect((await getResponse.json()).diagram.description).toBeNull();
});
