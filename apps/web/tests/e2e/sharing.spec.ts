import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';
const GRANTEE_EMAIL = 'architect@example.com';
const GRANTEE_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * User Story 6 end-to-end: the owner shares a diagram at "view" access — the recipient can open
 * it but editing is blocked; upgrading the grant to "edit" then allows the same edit.
 */
test('shares a diagram at view access (edit blocked), then upgrades to edit (allowed)', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const granteeContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const granteePage = await granteeContext.newPage();

  // Owner creates a diagram and shares it with the grantee at "view" access.
  await ownerPage.goto(`/?projectId=${PROJECT_ID}`);
  await ownerPage.getByTestId('login-email').fill(OWNER_EMAIL);
  await ownerPage.getByTestId('login-password').fill(OWNER_PASSWORD);
  await ownerPage.getByTestId('login-submit').click();
  await ownerPage.waitForURL('**/*');

  await ownerPage.getByTestId('new-diagram').click();
  await ownerPage.getByTestId('diagram-type-flowchart').check();
  await ownerPage.getByTestId('confirm-new-diagram').click();
  await expect(ownerPage.getByTestId('diagram-canvas')).toBeVisible();
  await ownerPage.getByTestId('add-shape-rectangle').click();
  await ownerPage.getByTestId('save-diagram').click();
  await expect(ownerPage.getByTestId('save-status')).toHaveText('saved');

  await ownerPage.getByTestId('open-share-dialog').click();
  await ownerPage.getByTestId('share-email').fill(GRANTEE_EMAIL);
  await ownerPage.getByTestId('share-access-level').selectOption('view');
  await ownerPage.getByTestId('confirm-share').click();
  await expect(ownerPage.getByTestId('share-grants')).toBeVisible();

  // Grantee opens the same project, finds the diagram, opens it (view access), edit is blocked.
  await granteePage.goto(`/?projectId=${PROJECT_ID}`);
  await granteePage.getByTestId('login-email').fill(GRANTEE_EMAIL);
  await granteePage.getByTestId('login-password').fill(GRANTEE_PASSWORD);
  await granteePage.getByTestId('login-submit').click();
  await granteePage.waitForURL('**/*');

  await expect(granteePage.getByTestId('project-browser')).toBeVisible();
  // Diagrams are listed newest-first (project.service.ts orders by created_at DESC), so the
  // diagram the owner just created is always the first match — order-independent across runs.
  const openButtons = granteePage.locator('[data-testid^="open-diagram-"]');
  await openButtons.first().click();
  await expect(granteePage.getByTestId('diagram-canvas')).toBeVisible();

  await granteePage.getByTestId('add-shape-circle').click();
  await granteePage.getByTestId('save-diagram').click();
  await expect(granteePage.getByTestId('save-status')).toHaveText('error');

  // Owner upgrades the grant to "edit".
  await ownerPage.getByTestId('share-access-level').selectOption('edit');
  await ownerPage.getByTestId('share-email').fill(GRANTEE_EMAIL);
  await ownerPage.getByTestId('confirm-share').click();

  // Grantee retries the save — now allowed.
  await granteePage.getByTestId('save-diagram').click();
  await expect(granteePage.getByTestId('save-status')).toHaveText('saved');

  await ownerContext.close();
  await granteeContext.close();
});
