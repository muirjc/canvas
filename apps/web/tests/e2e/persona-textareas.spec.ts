import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-cyq: persona prompts and reference material use a textarea that is compact at rest and
 * grows while in use, plus an Expand button for a large editor. Uses one persona created here
 * (and archived at the end), never a seeded one.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const NAME = `E2E Textarea Persona ${Date.now()}`;
const LONG_PROMPT = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long system prompt.`).join('\n');

let page: Page;
let personaId = '';

const row = () => page.getByTestId(`persona-row-${personaId}`);
const box = () => page.getByTestId(`persona-prompt-${personaId}`);
const status = () => page.getByTestId(`persona-prompt-status-${personaId}`);
const save = () => page.getByTestId(`persona-prompt-save-${personaId}`);
const height = async (locator = box()) => (await locator.boundingBox())!.height;

async function a11y() {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function openPersonas() {
  await page.goto('/?admin=ai-personas');
  await expect(page.getByTestId('persona-create-submit')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
});

test.afterAll(async () => {
  if (personaId) await page.request.post(`${API_BASE_URL}/admin/ai-personas/${personaId}/archive`);
  await page?.context().close();
});

test('the create-persona editor has Done only, and its text lands in the page field', async () => {
  await openPersonas();
  await page.getByTestId('persona-create-name').fill(NAME);
  await page.getByTestId('persona-create-category').selectOption('Enterprise');

  await page.getByTestId('persona-create-prompt-expand').click();
  await expect(page.getByTestId('persona-create-prompt-editor')).toBeVisible();
  await expect(page.getByTestId('persona-create-prompt-editor-save')).toHaveCount(0);
  await expect(page.getByTestId('persona-create-prompt-editor-done')).toBeVisible();
  await page.getByTestId('persona-create-prompt-editor-text').fill('A short prompt typed in the editor.');
  await page.getByTestId('persona-create-prompt-editor-done').click();
  await expect(page.getByTestId('persona-create-prompt-editor')).toHaveCount(0);
  await expect(page.getByTestId('persona-create-prompt')).toHaveValue('A short prompt typed in the editor.');

  await page.getByTestId('persona-create-submit').click();
  const created = page.locator('[data-testid^="persona-row-"]', { has: page.locator('strong', { hasText: NAME }) });
  await expect(created).toBeVisible();
  personaId = ((await created.getAttribute('data-testid')) ?? '').replace('persona-row-', '');
  expect(personaId).toBeTruthy();
});

test('the prompt box is compact at rest, grows on focus up to 70% of the window, and holds open while unsaved', async () => {
  await openPersonas();
  await expect(box()).toHaveAttribute('data-expanded', 'false');
  const compact = await height();
  expect(compact).toBeGreaterThan(30);
  expect(compact).toBeLessThan(130); // about three rows

  await box().fill(LONG_PROMPT);
  await expect(box()).toHaveAttribute('data-expanded', 'true');
  const grown = await height();
  expect(grown).toBeGreaterThan(compact * 2);
  expect(grown).toBeLessThanOrEqual(Math.round(720 * 0.7) + 1);

  // Blur by clicking elsewhere: still open because the draft is unsaved.
  await page.getByRole('heading', { level: 1 }).click();
  await expect(box()).not.toBeFocused();
  await expect(box()).toHaveAttribute('data-expanded', 'true');
  expect(Math.abs((await height()) - grown)).toBeLessThan(2);
  await expect(status()).toHaveText('Unsaved changes');

  // The Save button hasn't moved away: one click saves.
  await save().click();
  await expect(status()).toHaveText('Saved');
  // After saving, the box (now blurred) collapses again.
  await expect(box()).toHaveAttribute('data-expanded', 'false');
  expect(await height()).toBeLessThan(130);
  await expect(box()).toHaveValue(LONG_PROMPT);
});

test('Escape on an unchanged focused box collapses it', async () => {
  await openPersonas();
  await box().click();
  await expect(box()).toHaveAttribute('data-expanded', 'true');
  await expect(box()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(box()).toHaveAttribute('data-expanded', 'false');
  await expect(box()).not.toBeFocused();
});

test('the editor shows the same text, edits the page draft, saves, and Done and Escape keep the draft', async () => {
  await openPersonas();
  await page.getByTestId(`persona-prompt-${personaId}-expand`).click();
  const editor = page.getByTestId(`persona-prompt-${personaId}-editor`);
  const text = page.getByTestId(`persona-prompt-${personaId}-editor-text`);
  await expect(editor).toBeVisible();
  await expect(text).toHaveValue(LONG_PROMPT);
  await expect(page.getByTestId(`persona-prompt-${personaId}-editor-save`)).toBeDisabled();

  await text.fill('Edited in the large editor.');
  await expect(box()).toHaveValue('Edited in the large editor.');
  await expect(status()).toHaveText('Unsaved changes');
  await a11y(); // with the editor open

  // Save in the editor saves the same way as the page's button.
  await page.getByTestId(`persona-prompt-${personaId}-editor-save`).click();
  await expect(status()).toHaveText('Saved');
  await page.getByTestId(`persona-prompt-${personaId}-editor-done`).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await expect(box()).toHaveValue('Edited in the large editor.');

  // Done keeps an unsaved draft.
  await page.getByTestId(`persona-prompt-${personaId}-expand`).click();
  await text.fill('Draft kept after Done.');
  await page.getByTestId(`persona-prompt-${personaId}-editor-done`).click();
  await expect(editor).toHaveCount(0);
  await expect(box()).toHaveValue('Draft kept after Done.');
  await expect(status()).toHaveText('Unsaved changes');

  // Escape closes the editor and keeps the draft too.
  await page.getByTestId(`persona-prompt-${personaId}-expand`).click();
  await expect(editor).toBeVisible();
  await text.fill('Draft kept after Escape.');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(box()).toHaveValue('Draft kept after Escape.');
  await expect(status()).toHaveText('Unsaved changes');
});

test('reference material: add, then edit and Save in the editor', async () => {
  await openPersonas();
  await page.getByTestId(`reference-material-create-content-${personaId}`).fill('First reference note.');
  await page.getByTestId(`reference-material-create-submit-${personaId}`).click();
  const content = row().locator('textarea[data-testid^="reference-material-content-"]:not([data-testid$="-editor-text"])');
  await expect(content).toHaveCount(1);
  await expect(content).toHaveValue('First reference note.');
  const entryId = ((await content.getAttribute('data-testid')) ?? '').replace('reference-material-content-', '');

  await page.getByTestId(`reference-material-content-${entryId}-expand`).click();
  await expect(page.getByTestId(`reference-material-content-${entryId}-editor`)).toBeVisible();
  await page.getByTestId(`reference-material-content-${entryId}-editor-text`).fill('Reference note edited in the editor.');
  await page.getByTestId(`reference-material-content-${entryId}-editor-save`).click();
  await expect(page.getByTestId(`reference-material-status-${entryId}`)).toHaveText('Saved');
  await page.getByTestId(`reference-material-content-${entryId}-editor-done`).click();

  await page.reload();
  await expect(page.getByTestId(`reference-material-content-${entryId}`)).toHaveValue('Reference note edited in the editor.');
});

test('the page passes axe, and the persona admin page fits a 390px screen', async () => {
  await openPersonas();
  await a11y();
  await page.setViewportSize({ width: 390, height: 844 });
  await openPersonas();
  await expect(box()).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  await page.setViewportSize({ width: 1280, height: 720 });
});
