import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';
import { ensureCustomDiagramType } from './diagram-type-helpers';
import { ADMIN_EMAIL, ADMIN_PASSWORD, API_BASE_URL, PROJECT_ID } from './standards-v2-helpers';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-9ff: admins can hide any diagram type and delete an unused custom type from the Standards
 * admin page. Runs against the developer's real database, so only custom types created here are
 * ever hidden or deleted -- never a built-in one.
 */
test.describe.configure({ mode: 'serial' });

const createdTypeIds: string[] = [];
const createdDiagramIds: string[] = [];

async function login(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
}

async function createCustomType(page: Page, label: string): Promise<{ id: string; name: string }> {
  const name = `${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await page.request.post(`${API_BASE_URL}/admin/diagram-types`, {
    data: { name, dslFamily: 'flowchart', personas: ['Business', 'Enterprise', 'Solution', 'Technical'] },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).diagramType.id as string;
  createdTypeIds.push(id);
  return { id, name };
}

async function openAdminAndSelect(page: Page, typeId: string) {
  await page.goto(`/?projectId=${PROJECT_ID}&admin=standards`);
  await expectSignedIn(page);
  await page.getByTestId(`standards-type-${typeId}`).click();
}

async function openNewDiagramDialog(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expectSignedIn(page);
  await page.getByTestId('new-diagram').click();
  // The dialog lists types once loaded; the always-present built-in proves it has rendered.
  await expect(page.getByTestId('diagram-type-flowchart')).toBeVisible();
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  for (const id of createdDiagramIds) await page.request.delete(`${API_BASE_URL}/diagrams/${id}`);
  for (const id of createdTypeIds) {
    const del = await page.request.delete(`${API_BASE_URL}/admin/diagram-types/${id}`);
    // In use (a soft-deleted diagram still counts): can't delete, so hide it out of the pickers.
    if (del.status() === 409) {
      await page.request.patch(`${API_BASE_URL}/admin/diagram-types/${id}`, { data: { hidden: true } });
    }
  }
  await page.close();
});

test('hiding a type removes it from the New Diagram dialog; showing it restores it', async ({ page }) => {
  await login(page);
  const type = await createCustomType(page, 'Hide Me');

  await openAdminAndSelect(page, type.id);
  await page.getByTestId('diagram-type-hide-toggle').click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId(`standards-type-hidden-${type.id}`)).toBeVisible();

  await openNewDiagramDialog(page);
  await expect(page.getByTestId(`diagram-type-${type.id}`)).toHaveCount(0);

  await openAdminAndSelect(page, type.id);
  await expect(page.getByTestId('diagram-type-hide-toggle')).toHaveText('Show type');
  await page.getByTestId('diagram-type-hide-toggle').click();
  await expect(page.getByTestId(`standards-type-hidden-${type.id}`)).toHaveCount(0);

  await openNewDiagramDialog(page);
  await expect(page.getByTestId(`diagram-type-${type.id}`)).toBeVisible();
});

test('deleting a type that has diagrams is refused with a message pointing at hide', async ({ page }) => {
  await login(page);
  const name = 'E2E In Use';
  const type = { id: await ensureCustomDiagramType(page.request, { name, dslFamily: 'flowchart' }), name };
  createdTypeIds.push(type.id);
  const res = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: { name: `In use ${Date.now()}`, diagramTypeId: type.id, initialDslContent: 'flowchart TD\n  A[Start]\n' },
  });
  expect(res.status()).toBe(201);
  createdDiagramIds.push((await res.json()).diagram.id as string);

  await openAdminAndSelect(page, type.id);
  await page.getByTestId('diagram-type-delete').click();
  await page.getByTestId('diagram-type-delete-confirm').click();

  await expect(page.getByTestId('standards-error')).toContainText(/\d+ diagrams?/);
  await expect(page.getByTestId('standards-error')).toContainText(/hide/i);
  await expect(page.getByTestId(`standards-type-${type.id}`)).toBeVisible();
});

test('deleting an unused custom type removes it from the list and the API', async ({ page }) => {
  await login(page);
  const type = await createCustomType(page, 'Delete Me');

  await openAdminAndSelect(page, type.id);
  await page.getByTestId('diagram-type-delete').click();
  await expect(page.getByTestId('diagram-type-delete-dialog')).toBeVisible();
  await page.getByTestId('diagram-type-delete-confirm').click();

  await expect(page.getByTestId(`standards-type-${type.id}`)).toHaveCount(0);

  const list = await page.request.get(`${API_BASE_URL}/diagram-types?includeHidden=true`);
  expect(list.ok()).toBe(true);
  const ids = ((await list.json()).diagramTypes as { id: string }[]).map((t) => t.id);
  expect(ids).not.toContain(type.id);
});

test('built-in types offer no Delete button', async ({ page }) => {
  await login(page);
  await openAdminAndSelect(page, 'flowchart');
  await expect(page.getByTestId('diagram-type-hide-toggle')).toBeVisible();
  await expect(page.getByTestId('diagram-type-delete')).toHaveCount(0);
});
