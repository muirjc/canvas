import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const GUEST_EMAIL = 'guest@example.com';
const GUEST_PASSWORD = 'guest-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Automated WCAG 2.1 AA audit (constitution's Technology & Compliance Constraints) of the
 * editor toolbars and admin console, using axe-core. Checks against the WCAG 2.1 A/AA rule
 * sets; violations fail the test with the specific rule and affected elements, not just a
 * pass/fail summary.
 */
async function auditPage(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.describe('Accessibility (WCAG 2.1 AA)', () => {
  test('login page has no violations', async ({ page }) => {
    await page.goto('/');
    await auditPage(page);
  });

  test('main app screen (post-login) has no violations', async ({ page }) => {
    await page.goto(`/?projectId=${PROJECT_ID}`);
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/*');
    await auditPage(page);
  });

  test('diagram editor toolbar has no violations', async ({ page }) => {
    await page.goto(`/?projectId=${PROJECT_ID}`);
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/*');

    await page.getByTestId('new-diagram').click();
    await page.getByTestId('diagram-type-flowchart').check();
    await page.getByTestId('confirm-new-diagram').click();
    await page.getByTestId('diagram-canvas').waitFor();
    await auditPage(page);
  });

  test('admin standards console has no violations', async ({ page }) => {
    await page.goto('/?admin=true');
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/*?admin=true');
    await auditPage(page);
  });

  test('admin users console has no violations', async ({ page }) => {
    await page.goto('/?admin=users');
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/*?admin=users');
    await auditPage(page);
  });

  test('admin deleted-diagrams console has no violations', async ({ page }) => {
    await page.goto('/?admin=deleted');
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/*?admin=deleted');
    await auditPage(page);
  });

  test('the delete-confirmation dialog (ConfirmDialog) has no violations while open', async ({ page }) => {
    await page.goto(`/?projectId=${PROJECT_ID}`);
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();
    await page.waitForURL('**/*');

    await page.getByTestId('new-diagram').click();
    await page.getByTestId('diagram-type-flowchart').check();
    await page.getByTestId('confirm-new-diagram').click();
    await page.getByTestId('diagram-canvas').waitFor();

    await page.getByTestId('add-shape-rectangle').click();
    await page.locator('[data-testid^="node-"]').first().click();
    await page.getByTestId('delete-selected').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await auditPage(page);
  });

  test('the home screen with a shared-diagrams section has no violations', async ({ browser }) => {
    // Feature 008 — none of the audited states above include this section, so it is otherwise
    // unvalidated by omission (contracts/ui-contract.md).
    const adminContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const guestPage = await guestContext.newPage();

    await adminPage.goto('/');
    await adminPage.getByTestId('login-email').fill(ADMIN_EMAIL);
    await adminPage.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await adminPage.getByTestId('login-submit').click();
    await expect(adminPage.getByTestId('sign-out')).toBeVisible();

    const projectResponse = await adminPage.request.post(`${API_BASE_URL}/projects`, {
      data: { name: `A11y Shared Source ${Date.now()}` },
    });
    const projectId = (await projectResponse.json()).project.id;
    const diagramResponse = await adminPage.request.post(`${API_BASE_URL}/projects/${projectId}/diagrams`, {
      data: { name: `A11y Shared Diagram ${Date.now()}`, diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
    });
    const diagramId = (await diagramResponse.json()).diagram.id;
    const lookup = await adminPage.request.get(`${API_BASE_URL}/users/lookup?email=${encodeURIComponent(GUEST_EMAIL)}`);
    const { user } = await lookup.json();
    const shareResponse = await adminPage.request.post(`${API_BASE_URL}/diagrams/${diagramId}/shares`, {
      data: { granteeUserId: user.id, accessLevel: 'view' },
    });
    const grantId = (await shareResponse.json()).grant.id;

    try {
      await guestPage.goto('/');
      await guestPage.getByTestId('login-email').fill(GUEST_EMAIL);
      await guestPage.getByTestId('login-password').fill(GUEST_PASSWORD);
      await guestPage.getByTestId('login-submit').click();
      await expect(guestPage.getByTestId('shared-diagrams')).toBeVisible();
      await auditPage(guestPage);
    } finally {
      // `guest@example.com` is a shared, persistent fixture (apps/api/src/seed/run.ts) other
      // specs rely on starting with zero shares (shared-diagrams.spec.ts's first test) — leaving
      // this grant behind would make that test's outcome depend on file execution order.
      await adminPage.request.delete(`${API_BASE_URL}/shares/${grantId}`);
      await adminContext.close();
      await guestContext.close();
    }
  });
});
