import { expect, test } from '@playwright/test';
import { saveDsl } from './save-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/** canvas-93n: the Projects page lists the diagrams you opened recently on this browser. */
test('an opened diagram is listed under Recently opened, and drops out once deleted', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill('admin@example.com');
  await page.getByTestId('login-password').fill('admin-dev-password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();

  const name = `Recent ${Date.now()}`;
  const created = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, { data: { name, diagramTypeId: 'flowchart' } });
  const id = (await created.json()).diagram.id as string;
  expect((await saveDsl(page.request, API_BASE_URL, id, 'flowchart TD\n  a[Start]\n')).status()).toBe(200);

  await page.goto(`/?diagramId=${id}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('nav-projects').click();
  const link = page.getByTestId(`recent-diagram-${id}`);
  await expect(link).toHaveText(name);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`diagramId=${id}`));

  expect((await page.request.delete(`${API_BASE_URL}/diagrams/${id}`)).status()).toBe(204);
  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('projects-page-list').or(page.getByTestId('projects-page-all-list')).first()).toBeVisible();
  await expect(page.getByTestId(`recent-diagram-${id}`)).toHaveCount(0);
});
