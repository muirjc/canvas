import { expect, type Page } from '@playwright/test';

export const PROJECT_ID = process.env.E2E_PROJECT_ID;
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'admin-dev-password';
export const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export async function login(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

export async function newDiagram(page: Page, typeId: string) {
  await page.getByTestId('new-diagram').click();
  await page.getByTestId(`diagram-type-${typeId}`).check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

export async function readDsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

export async function applyDsl(page: Page, dsl: string) {
  await page.getByTestId('rail-tab-dsl').click();
  await page.getByTestId('dsl-panel').fill(dsl);
  await page.getByTestId('apply-dsl').click();
}

export async function nodeIds(page: Page): Promise<string[]> {
  const ids = await page.locator('[data-testid^="node-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')!.replace('node-', '')),
  );
  return ids;
}

/** Click an add-kind button and return the id of the node it created. */
export async function addKind(page: Page, kindId: string): Promise<string> {
  const before = await nodeIds(page);
  await page.getByTestId(`add-kind-${kindId}`).click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(before.length + 1);
  const after = await nodeIds(page);
  return after.find((id) => !before.includes(id))!;
}
