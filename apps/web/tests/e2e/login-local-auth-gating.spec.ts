import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

// canvas-cpa: matches every other spec's skip guard for consistency, even though this file never
// navigates into a project -- the login screen itself needs no project id, only a running,
// seeded API (which `npm run seed` also guarantees).
test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * Stubs GET /auth/config's response before the app's first request to it (LoginForm's mount-time
 * useEffect) -- the real endpoint always returns `{ oidcEnabled: false, localAuthEnabled: true }`
 * in this repo's local dev/e2e stack (ALLOW_LOCAL_AUTH=true, no OIDC_* configured), so the other
 * three combinations this bead cares about (canvas-cpa: a deployment with local auth off, e.g.
 * Azure's default) can only be exercised by controlling the response directly, not by changing
 * server config per test.
 */
async function stubAuthConfig(page: Page, oidcEnabled: boolean, localAuthEnabled: boolean): Promise<void> {
  await page.route('**/auth/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ oidcEnabled, localAuthEnabled }),
    }),
  );
}

test.describe('login screen respects /auth/config (canvas-cpa)', () => {
  test('local auth off, SSO on: password fields/submit/error are hidden, only the SSO link shows', async ({
    page,
  }) => {
    await stubAuthConfig(page, true, false);
    await page.goto('/');

    await expect(page.getByTestId('sso-login-link')).toBeVisible();

    await expect(page.getByTestId('login-email')).toHaveCount(0);
    await expect(page.getByTestId('login-password')).toHaveCount(0);
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await expect(page.getByTestId('login-error')).toHaveCount(0);
    await expect(page.getByTestId('login-unavailable')).toHaveCount(0);

    // No "or" divider -- there's nothing left to divide once the password form is gone.
    await expect(page.getByRole('separator')).toHaveCount(0);
  });

  test('local auth on, SSO off: the password form shows and no SSO link is rendered (unchanged default behavior)', async ({
    page,
  }) => {
    await stubAuthConfig(page, false, true);
    await page.goto('/');

    await expect(page.getByTestId('login-email')).toBeVisible();
    await expect(page.getByTestId('login-password')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();

    await expect(page.getByTestId('sso-login-link')).toHaveCount(0);
    await expect(page.getByTestId('login-unavailable')).toHaveCount(0);
    await expect(page.getByRole('separator')).toHaveCount(0);

    // The actual regression this bead closes: submitting still works end to end (no raw 404
    // surfaced as the error), rather than only asserting the fields are present.
    await page.getByTestId('login-email').fill('admin@example.com');
    await page.getByTestId('login-password').fill('admin-dev-password');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('sign-out')).toBeVisible();
  });

  test('both local auth and SSO off: shows the login-unavailable message instead of any form', async ({ page }) => {
    await stubAuthConfig(page, false, false);
    await page.goto('/');

    const unavailable = page.getByTestId('login-unavailable');
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText('No sign-in method is configured for this deployment');

    await expect(page.getByTestId('login-email')).toHaveCount(0);
    await expect(page.getByTestId('login-password')).toHaveCount(0);
    await expect(page.getByTestId('login-submit')).toHaveCount(0);
    await expect(page.getByTestId('sso-login-link')).toHaveCount(0);
  });
});
