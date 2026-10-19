import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-0sa: the shared Modal's open/close effect depended on `onClose`; callers pass an inline
 * arrow, so every re-render (each keystroke) closed the <dialog> and re-ran showModal(), which
 * focuses the first focusable control. Typing in "Describe the diagram you want" kept jumping to
 * Name. These tests type with `keyboard.type` (one keystroke -> one re-render); `fill` would set
 * the value in a single step and never reproduce the bug.
 */
const SENTENCE = 'A customer places an order and the warehouse ships it';

async function signIn(page: Page): Promise<void> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);
  await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
}

async function openCreateDialog(page: Page) {
  await page.getByTestId('create-via-ai-chat').click();
  const dialog = page.getByRole('dialog', { name: 'Create via AI Chat' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('typing in the Create via AI Chat description keeps focus there and does not touch Name', async ({ page }) => {
  await signIn(page);
  await openCreateDialog(page);

  const description = page.getByTestId('ai-create-description');
  const name = page.getByTestId('ai-create-name');
  const nameBefore = await name.inputValue();

  await description.click();
  await page.keyboard.type(SENTENCE);

  await expect(description).toHaveValue(SENTENCE);
  await expect(description).toBeFocused();
  await expect(name).toHaveValue(nameBefore);
});

test('typing in the Diagram details description keeps all keystrokes in that field', async ({ page }) => {
  await signIn(page);
  const response = await page.request.post(`${API_BASE_URL}/projects/${PROJECT_ID}/diagrams`, {
    data: {
      name: `Modal Focus ${Date.now()}`,
      diagramTypeId: 'flowchart',
      initialDslContent: 'flowchart TD\n  A[Start]\n',
    },
  });
  expect(response.status()).toBe(201);
  const diagramId = (await response.json()).diagram.id;

  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId(`open-diagram-${diagramId}`).click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await page.getByTestId('open-diagram-details').click();
  await expect(page.getByTestId('diagram-details')).toBeVisible();

  const description = page.getByTestId('diagram-description-input');
  await description.click();
  await page.keyboard.type(SENTENCE);

  await expect(description).toHaveValue(SENTENCE);
  await expect(description).toBeFocused();
});

test('Escape and Cancel close the Create via AI Chat dialog, focus returns to the opener, and it reopens', async ({
  page,
}) => {
  await signIn(page);
  const opener = page.getByTestId('create-via-ai-chat');
  const dialog = page.getByRole('dialog', { name: 'Create via AI Chat' });

  await openCreateDialog(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Reopening works after an Escape close, and the Cancel button closes it too.
  await openCreateDialog(page);
  await page.getByTestId('ai-create-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
