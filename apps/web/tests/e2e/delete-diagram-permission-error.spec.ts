import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const OWNER_EMAIL = 'admin@example.com';
const OWNER_PASSWORD = 'admin-dev-password';
const GRANTEE_EMAIL = 'architect@example.com';
const GRANTEE_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-40t: DELETE /diagrams/:id requires `requireDiagramOwnerOrAdmin()` — a user with only
 * edit access (via a share grant, not the owner, not an admin) gets a 403. Before this fix,
 * `confirmDelete` had no try/catch: the rejection had nowhere to go, so the confirm dialog just
 * sat open forever with no error shown, indistinguishable from a hang. This proves the dialog now
 * closes, a specific error message is surfaced, and — most importantly — the diagram was never
 * actually deleted by the failed attempt.
 *
 * `architect@example.com` already has a permanent project-level "edit" grant on the seeded
 * project (apps/api/src/seed/run.ts — see shared-diagrams.spec.ts's own note on this), so no
 * explicit per-diagram share is needed here: it is enough to have the owner create a diagram in
 * that same project and have the architect find it via the ordinary project browser, exactly as
 * they would for any diagram they didn't create.
 */
test('non-owner with only edit access gets a clear error on delete; dialog closes; diagram survives', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const granteeContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const granteePage = await granteeContext.newPage();

  const diagramName = `Delete Permission Check ${Date.now()}`;

  // Owner creates a diagram (import persists it immediately, giving it a findable unique name).
  await ownerPage.goto(`/?projectId=${PROJECT_ID}`);
  await ownerPage.getByTestId('login-email').fill(OWNER_EMAIL);
  await ownerPage.getByTestId('login-password').fill(OWNER_PASSWORD);
  await ownerPage.getByTestId('login-submit').click();
  await ownerPage.waitForURL('**/*');

  await ownerPage.getByTestId('import-diagram-button').click();
  await ownerPage.getByTestId('import-name').fill(diagramName);
  await ownerPage.getByTestId('import-textarea').fill('flowchart TD\n  A[Node]\n');
  await ownerPage.getByTestId('confirm-import').click();
  await expect(ownerPage.getByTestId('diagram-canvas')).toBeVisible();

  // Grantee (non-owner, edit-only project access) finds the diagram in the project browser and
  // attempts to delete it.
  await granteePage.goto(`/?projectId=${PROJECT_ID}`);
  await granteePage.getByTestId('login-email').fill(GRANTEE_EMAIL);
  await granteePage.getByTestId('login-password').fill(GRANTEE_PASSWORD);
  await granteePage.getByTestId('login-submit').click();
  await granteePage.waitForURL('**/*');

  const projectBrowser = granteePage.getByTestId('project-browser');
  await expect(projectBrowser).toBeVisible();
  const row = projectBrowser.locator('li.row', { hasText: diagramName });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Delete' }).click();

  await expect(granteePage.getByTestId('confirm-dialog')).toBeVisible();
  await granteePage.getByTestId('confirm-dialog-confirm').click();

  // The confirm dialog closes rather than hanging open, and a specific server-provided error
  // message is shown instead of silence.
  await expect(granteePage.getByTestId('confirm-dialog')).not.toBeVisible();
  const errorMessage = granteePage.getByTestId('delete-diagram-error');
  await expect(errorMessage).toBeVisible();
  await expect(errorMessage).toContainText('owner or an admin');

  // Crucially, the diagram itself was never actually deleted by the failed attempt.
  await expect(row).toBeVisible();

  await ownerContext.close();
  await granteeContext.close();
});
