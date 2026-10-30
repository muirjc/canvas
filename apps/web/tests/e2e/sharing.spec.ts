import { expect, test } from '@playwright/test';
import { showShareButton } from './app-settings-helpers';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const RUN = Date.now();
// canvas-2h2w.1: a fresh architect with no project access. The seeded architect already has Edit on
// the Smoke Test project, and a diagram-level View no longer hides that (the highest level wins).
const GRANTEE_EMAIL = `e2e-user-${RUN}-grantee@example.com`;
const GRANTEE_PASSWORD = 'Lantern-orchid-basalt-31'; // gitleaks:allow

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 6 end-to-end: the owner shares a diagram at "view" access — the recipient can open
 * it but editing is blocked; upgrading the grant to "edit" then allows the same edit.
 */
test('shares a diagram at view access (read-only), then upgrades to edit (allowed)', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  await showShareButton(ownerContext);
  const granteeContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const granteePage = await granteeContext.newPage();

  // Owner creates a diagram and shares it with the grantee at "view" access.
  await ownerPage.goto(`/?projectId=${PROJECT_ID}`);
  await ownerPage.getByTestId('login-email').fill(OWNER_EMAIL);
  await ownerPage.getByTestId('login-password').fill(OWNER_PASSWORD);
  await ownerPage.getByTestId('login-submit').click();
  await expectSignedIn(ownerPage);

  await ownerPage.getByTestId('new-diagram').click();
  await ownerPage.getByTestId('diagram-type-flowchart').check();
  await ownerPage.getByTestId('confirm-new-diagram').click();
  await expect(ownerPage.getByTestId('diagram-canvas')).toBeVisible();
  await ownerPage.getByTestId('add-shape-rectangle').click();
  await ownerPage.getByTestId('save-diagram').click();
  await expect(ownerPage.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  const diagramId = new URL(ownerPage.url()).searchParams.get('diagramId')!;
  const created = await ownerPage.request.post(`${API_BASE_URL}/admin/users`, { data: { email: GRANTEE_EMAIL, name: `E2E Grantee ${RUN}`, role: 'architect' } });
  expect(created.status()).toBe(201);
  const temporaryPassword = (await created.json()).temporaryPassword as string;
  expect((await granteeContext.request.post(`${API_BASE_URL}/auth/local/login`, { data: { email: GRANTEE_EMAIL, password: temporaryPassword } })).status()).toBe(200);
  expect(
    (await granteeContext.request.post(`${API_BASE_URL}/auth/password`, { data: { currentPassword: temporaryPassword, newPassword: GRANTEE_PASSWORD } })).status(),
  ).toBe(200);

  await ownerPage.getByTestId('open-share-dialog').click();
  await ownerPage.getByTestId('share-email').fill(GRANTEE_EMAIL);
  await ownerPage.getByTestId('share-access-level').selectOption('view');
  await ownerPage.getByTestId('confirm-share').click();
  await expect(ownerPage.getByTestId('share-grants')).toBeVisible();

  // Grantee (already signed in above) opens the diagram with View access: read-only.
  await granteePage.goto(`/?diagramId=${diagramId}`);
  await expect(granteePage.getByTestId('diagram-canvas')).toBeVisible();

  // canvas-2h2w.1: View opens the editor read-only -- no tools, no Save.
  await expect(granteePage.getByTestId('read-only-badge')).toBeVisible();
  await expect(granteePage.getByTestId('save-diagram')).toHaveCount(0);

  // Owner upgrades the grant to "edit".
  await ownerPage.getByTestId('share-access-level').selectOption('edit');
  await ownerPage.getByTestId('share-email').fill(GRANTEE_EMAIL);
  await ownerPage.getByTestId('confirm-share').click();
  // Wait for the upgrade to be stored before the grantee retries -- clicking Save straight away
  // raced the share request on a slow CI runner (PR #230) and got the old "view" answer.
  await expect(ownerPage.getByTestId('share-grants')).toContainText('edit');

  // Grantee reopens the diagram with Edit -- now they can change and save it.
  await granteePage.reload();
  await granteePage.getByTestId('add-shape-circle').click();
  await granteePage.getByTestId('save-diagram').click();
  await expect(granteePage.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  await ownerContext.close();
  await granteeContext.close();
});
