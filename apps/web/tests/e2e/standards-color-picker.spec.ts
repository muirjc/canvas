import { expect, test } from '@playwright/test';
import { API_BASE_URL, PROJECT_ID, login } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-lti: choosing a colour in the standards editor's colour picker only set a local draft; it
 * joined the kind's approvedFills after a separate "Add color" click, so Save silently dropped it.
 * Committing a colour in the picker now adds it, and the hex box adds on Enter.
 *
 * Runs against the developer's real database, so it works on a uniquely named CUSTOM flowchart-family
 * type, never a built-in one, and retires its standard afterwards.
 */
test.describe.configure({ mode: 'serial' });

let typeId = '';
let standardId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  const res = await page.request.post(`${API_BASE_URL}/admin/diagram-types`, {
    data: {
      name: `Color Picker ${Date.now()}`,
      dslFamily: 'flowchart',
      personas: ['Business', 'Enterprise', 'Solution', 'Technical'],
    },
  });
  expect(res.status()).toBe(201);
  typeId = (await res.json()).diagramType.id as string;
  await page.close();
});

test.afterAll(async ({ browser }) => {
  // A custom type has no delete route, so retire its standard.
  const page = await browser.newPage();
  await login(page);
  if (!standardId) {
    const list = await page.request.get(`${API_BASE_URL}/diagram-types/${typeId}/standards`);
    if (list.ok()) {
      const body = await list.json();
      for (const s of body.standards ?? []) await page.request.post(`${API_BASE_URL}/standards/${s.id}/retire`);
    }
  } else {
    await page.request.post(`${API_BASE_URL}/standards/${standardId}/retire`);
  }
  await page.close();
});

async function openTypeInAdmin(page: import('@playwright/test').Page) {
  await page.goto('/?admin=standards');
  await expect(page.getByTestId('standard-new')).toBeVisible();
  await page.getByTestId(`standards-type-${typeId}`).click();
  await expect(page.getByTestId(`standards-type-${typeId}`)).toHaveAttribute('aria-current', 'true');
}

test('a colour chosen in the picker alone is added, saved and still there after reload', async ({ page }) => {
  await login(page);
  await openTypeInAdmin(page);

  await page.getByTestId('standard-new').click();
  await page.getByTestId('standard-name-input').fill('Picker only');
  await page.getByTestId('kind-add').click();
  await page.getByTestId('kind-label-0').fill('Picked Kind');
  await page.getByTestId('kind-shape-0-rectangle').check();

  // Picker only: fill() on a colour input dispatches input + change. No "Add color" click.
  await page.getByTestId('kind-fill-0-picker').fill('#aabbcc');
  await expect(page.getByTestId('kind-fill-0-chip-0')).toContainText('#aabbcc');
  await page.getByTestId('kind-stroke-0-picker').fill('#112233');
  await expect(page.getByTestId('kind-stroke-0-chip-0')).toContainText('#112233');

  const saved = page.waitForResponse((r) => /\/diagram-types\/[^/]+\/standards$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByTestId('standard-save').click();
  await expect(page.getByTestId('standard-saved-note')).toContainText('Draft saved');
  standardId = (await (await saved).json()).standard.id as string;

  await page.getByTestId('standard-publish').click();
  await page.getByTestId('standard-publish-confirm-button').click();
  await expect(page.getByTestId('standards-editor-message')).toContainText('Published standard');

  // Stored server-side, not just in editor state.
  const stored = await page.request.get(`${API_BASE_URL}/diagram-types/${typeId}/standard`);
  expect(stored.ok()).toBe(true);
  const standard = (await stored.json()).standard as { id: string; rules: { elementKinds: { approvedFills: string[]; approvedStrokes: string[] }[] } };
  expect(standard.id).toBe(standardId);
  const kind = standard.rules.elementKinds[0];
  expect(kind.approvedFills).toEqual(['#aabbcc']);
  expect(kind.approvedStrokes).toEqual(['#112233']);

  // Reload and reopen the standard from the list.
  await page.reload();
  await expect(page.getByTestId('standard-new')).toBeVisible();
  await page.getByTestId(`standards-type-${typeId}`).click();
  const row = page.locator('[data-testid^="standard-row-"]').first();
  await expect(row).toContainText('Published');
  await row.locator('[data-testid^="standard-edit-"]').click();
  await expect(page.getByTestId('kind-fill-0-chip-0')).toContainText('#aabbcc');
  await expect(page.getByTestId('kind-stroke-0-chip-0')).toContainText('#112233');
});

test('a typed hex value shows a pending warning until Enter adds it', async ({ page }) => {
  await login(page);
  await openTypeInAdmin(page);

  await page.getByTestId('standard-new').click();
  await page.getByTestId('kind-add').click();

  await page.getByTestId('kind-fill-0-hex').fill('#ff8800');
  await expect(page.getByTestId('kind-fill-0-pending')).toContainText("#ff8800 isn't added yet");
  await expect(page.getByTestId('kind-fill-0-chip-0')).toHaveCount(0);

  await page.getByTestId('kind-fill-0-hex').press('Enter');
  await expect(page.getByTestId('kind-fill-0-chip-0')).toContainText('#ff8800');
  await expect(page.getByTestId('kind-fill-0-pending')).toHaveCount(0);

  // Nothing was saved in this test; leave the unsaved draft behind.
  await page.getByTestId('standard-cancel').click();
});
