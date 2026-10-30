import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signInAsAdmin(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill('admin@example.com');
  await page.getByTestId('login-password').fill('admin-dev-password');
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
}

async function openNewDiagram(page: Page): Promise<string> {
  const created = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: { name: `Share switch ${Date.now()}`, diagramTypeId: 'flowchart' },
  });
  expect(created.status()).toBe(201);
  const diagramId = (await created.json()).diagram.id as string;
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  return diagramId;
}

/**
 * canvas-8em: the Share button is hidden unless an admin turns sharing on. This is the one spec
 * that changes the real (global) setting; it always leaves it off again. Other specs that need the
 * button answer the settings request for their own page (app-settings-helpers.ts).
 */
test('the Share button is hidden by default and an admin can turn it on from Admin Overview', async ({ page }) => {
  await signInAsAdmin(page);
  try {
    await page.request.patch(`${API_BASE_URL}/admin/app-settings`, { data: { sharingEnabled: false } });

    await openNewDiagram(page);
    await expect(page.getByTestId('doc-bar')).toBeVisible();
    await expect(page.getByTestId('open-share-dialog')).toHaveCount(0);

    await page.goto('/?admin=overview');
    const toggle = page.getByTestId('sharing-enabled-toggle');
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(async () => (await (await page.request.get(`${API_BASE_URL}/app-settings`)).json()).sharingEnabled).toBe(true);

    await openNewDiagram(page);
    await expect(page.getByTestId('open-share-dialog')).toBeVisible();
  } finally {
    await page.request.patch(`${API_BASE_URL}/admin/app-settings`, { data: { sharingEnabled: false } });
  }
});
