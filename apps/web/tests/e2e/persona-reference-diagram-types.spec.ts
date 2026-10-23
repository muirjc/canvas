import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-ne8: the "Applies to diagram types" ticks of the add-reference-material form read like a
 * persona setting but had no Save, so they were a draft lost on reload. The add form is now
 * collapsed behind "Add reference material"; an existing entry's ticks have a Save that persists.
 * Uses one persona created here (archived at the end), never a seeded one.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const NAME = `E2E RefMat Persona ${Date.now()}`;
let page: Page;
let personaId = '';
let entryId = '';

const start = () => page.getByTestId(`reference-material-start-create-${personaId}`);
const form = () => page.getByTestId(`reference-material-create-${personaId}`);
const family = (id: string, f: string) => page.getByTestId(`reference-material-family-${id}-${f}`);

async function openPersonas() {
  await page.goto('/?admin=ai-personas');
  await expect(page.getByTestId('persona-create-submit')).toBeVisible();
}

async function a11y() {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto('/');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
  const created = await page.request.post(`${API_BASE_URL}/admin/ai-personas`, {
    data: { name: NAME, category: 'Technical', systemPrompt: 'Persona for reference-material tests.' },
  });
  expect(created.status()).toBe(201);
  personaId = (await created.json()).persona.id;
});

test.afterAll(async () => {
  if (personaId) await page.request.post(`${API_BASE_URL}/admin/ai-personas/${personaId}/archive`);
  await page?.context().close();
});

test('the add form and its diagram-type ticks are hidden until "Add reference material" is clicked', async () => {
  await openPersonas();
  await expect(start()).toBeVisible();
  await expect(form()).toHaveCount(0);
  await expect(page.getByTestId(`reference-material-create-content-${personaId}`)).toHaveCount(0);
  await expect(page.getByTestId(`reference-material-create-family-${personaId}-erd`)).toHaveCount(0);

  await start().click();
  await expect(form()).toBeVisible();
  await expect(form()).toContainText('New reference material');
  await expect(page.getByTestId(`reference-material-create-family-${personaId}-erd`)).toBeVisible();
  await expect(page.getByTestId(`reference-material-create-submit-${personaId}`)).toBeDisabled();
  await a11y(); // with the form open
});

test('Cancel discards the draft and hides the form', async () => {
  await openPersonas();
  await start().click();
  await page.getByTestId(`reference-material-create-content-${personaId}`).fill('A draft that will be discarded.');
  await page.getByTestId(`reference-material-create-family-${personaId}-uml`).check();
  await page.getByTestId(`reference-material-create-cancel-${personaId}`).click();
  await expect(form()).toHaveCount(0);

  // Reopening starts clean.
  await start().click();
  await expect(page.getByTestId(`reference-material-create-content-${personaId}`)).toHaveValue('');
  await expect(page.getByTestId(`reference-material-create-family-${personaId}-uml`)).not.toBeChecked();
  await page.getByTestId(`reference-material-create-cancel-${personaId}`).click();
  await expect(page.locator(`[data-testid="persona-row-${personaId}"] [data-testid^="reference-material-row-"]`)).toHaveCount(0);
});

test('Add with diagram types creates the entry and closes the form', async () => {
  await openPersonas();
  await start().click();
  await page.getByTestId(`reference-material-create-content-${personaId}`).fill('Entry scoped to ERD.');
  await page.getByTestId(`reference-material-create-family-${personaId}-erd`).check();
  await page.getByTestId(`reference-material-create-submit-${personaId}`).click();

  await expect(form()).toHaveCount(0);
  const content = page.locator(`[data-testid="persona-row-${personaId}"] textarea[data-testid^="reference-material-content-"]:not([data-testid$="-editor-text"])`);
  await expect(content).toHaveCount(1);
  await expect(content).toHaveValue('Entry scoped to ERD.');
  entryId = ((await content.getAttribute('data-testid')) ?? '').replace('reference-material-content-', '');
  expect(entryId).toBeTruthy();
  await expect(family(entryId, 'erd')).toBeChecked();
  await expect(family(entryId, 'uml')).not.toBeChecked();
  // The button is back for another entry.
  await expect(start()).toBeVisible();
});

test('changing an existing entry\'s diagram types enables Save, and the ticks persist after a reload', async () => {
  await openPersonas();
  await expect(family(entryId, 'erd')).toBeChecked();
  const save = page.getByTestId(`reference-material-save-${entryId}`);
  await expect(save).toBeDisabled();

  await family(entryId, 'uml').check();
  await expect(save).toBeEnabled();
  await expect(page.getByTestId(`reference-material-status-${entryId}`)).toHaveText('Unsaved changes');
  await save.click();
  await expect(page.getByTestId(`reference-material-status-${entryId}`)).toHaveText('Saved');
  await expect(save).toBeDisabled();

  await page.reload();
  await expect(family(entryId, 'erd')).toBeChecked();
  await expect(family(entryId, 'uml')).toBeChecked();
  await expect(family(entryId, 'sequence')).not.toBeChecked();
  await expect(save).toBeDisabled();
});

test('unticking every diagram type saves the entry as applying to all', async () => {
  await openPersonas();
  await family(entryId, 'erd').uncheck();
  await family(entryId, 'uml').uncheck();
  const save = page.getByTestId(`reference-material-save-${entryId}`);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByTestId(`reference-material-status-${entryId}`)).toHaveText('Saved');

  await page.reload();
  for (const f of ['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml']) {
    await expect(family(entryId, f)).not.toBeChecked();
  }
  // Server-side it is stored as unscoped (an empty family list).
  const list = await page.request.get(`${API_BASE_URL}/admin/ai-personas/${personaId}/reference-material`);
  expect(list.status()).toBe(200);
  const entries = (await list.json()).entries as { id: string; families?: string[]; diagramFamilies?: string[] }[];
  const entry = entries.find((e) => e.id === entryId)!;
  expect(entry.families ?? entry.diagramFamilies ?? []).toEqual([]);
});
