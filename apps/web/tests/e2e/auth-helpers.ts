import { expect, type Page } from '@playwright/test';

/**
 * canvas-1r1: waits until the app has actually signed the user in -- the header's sign-out
 * control only renders for an authenticated session (AppShell).
 *
 * Specs used to follow the login click with `page.waitForURL('**\/*')`, which matches the current
 * URL immediately and so never waited for the login response. A `page.request` call made next
 * could go out before the session cookie existed and get a 401 -- a latent race that started
 * failing in CI once sign-in got slower (database-backed sessions, canvas-4xo).
 */
export async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByTestId('sign-out')).toBeVisible();
}
