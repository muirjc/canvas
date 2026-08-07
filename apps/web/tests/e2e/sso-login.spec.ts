import { expect, test, type Page } from '@playwright/test';
import { generateSync } from 'otplib';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
// canvas-mi9: distinct from every other e2e spec's skip guard -- this one needs a *running local
// Keycloak* (docker compose up keycloak) with the API server started with OIDC_ISSUER_URL/
// CLIENT_ID/CLIENT_SECRET/REDIRECT_URI pointed at it (see RUNBOOK.md's "Keycloak SSO" section),
// which is not part of the default `npm run dev` flow every other spec assumes. Not run in CI
// today for the same reason (standing up Keycloak there is tracked separately, not a blocker for
// shipping the SSO integration itself).
const SSO_READY = process.env.E2E_SSO_READY === '1';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');
test.skip(!SSO_READY, 'E2E_SSO_READY=1 not set -- needs a local Keycloak + OIDC-configured API, see RUNBOOK.md');

/**
 * Drives a REAL Keycloak login, including first-time TOTP (MFA) enrollment, through Keycloak's
 * actual login theme -- not a mock. `secret` is read live from the enrollment page's own manual-
 * entry display (`#kc-totp-secret-key`), never hardcoded, since Keycloak generates a fresh one
 * per enrollment.
 */
async function completeSsoLogin(page: Page, email: string, password: string): Promise<void> {
  await page.getByTestId('sso-login-link').click();

  // Keycloak's own login theme -- not a canvas testid.
  await page.locator('#username').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();

  // First-time login for a freshly realm-imported user: Keycloak's CONFIGURE_TOTP required
  // action blocks completion until enrollment succeeds (canvas-mi9's actual MFA enforcement,
  // not just realm config that's never exercised).
  await page.locator('#mode-manual').click();
  const secret = (await page.locator('#kc-totp-secret-key').innerText()).replace(/\s+/g, '');
  const code = generateSync({ algorithm: 'sha1', digits: 6, period: 30, secret });
  await page.locator('#totp').fill(code);
  await page.locator('#saveTOTPBtn').click();

  // Back on canvas's own origin, signed in.
  await page.waitForURL('**/*');
}

test('signing in via Keycloak SSO (with first-time MFA enrollment) creates a canvas session with the mapped role', async ({
  page,
}) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('sso-login-link')).toBeVisible();

  // infra/keycloak/CanvasRealm-realm.json seeds this user with realm role "admin" -- a fresh
  // email canvas has never seen locally, so success here can only come from oidc.ts's
  // find-or-create + role-mapping path, not accidentally reusing seeded local-auth data.
  await completeSsoLogin(page, 'sso-admin@example.com', 'sso-admin-dev-password');

  // role: 'admin' gates the admin nav section (App.tsx) -- the clearest end-to-end proof the
  // realm_access.roles claim was read and mapped correctly, not just that *a* session exists.
  await expect(page.getByTestId('admin-overview-link')).toBeVisible();
  await expect(page.getByTestId('sign-out')).toBeVisible();
});

test('a Keycloak user mapped to the architect realm role does not see the admin nav', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('sso-login-link')).toBeVisible();

  await completeSsoLogin(page, 'sso-architect@example.com', 'sso-architect-dev-password');

  await expect(page.getByTestId('sign-out')).toBeVisible();
  await expect(page.getByTestId('admin-overview-link')).toHaveCount(0);
});
