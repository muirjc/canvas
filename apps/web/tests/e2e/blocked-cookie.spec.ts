import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-ao2: a browser that drops Canvas's session cookie (private windows, Safari/iPhone
 * cross-site rules) made sign-in look like it did nothing. Now the sign-in form says why. The
 * dropped cookie is simulated by removing Set-Cookie from the login response.
 */

async function dropSessionCookie(page: Page) {
  await page.route('**/auth/local/login', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    // route.fetch() runs in the context's request client, which stores Set-Cookie in the browser
    // context's own cookie jar -- clear it, or dropping the header from the response changes nothing.
    await page.context().clearCookies();
    const headers = { ...response.headers() };
    delete headers['set-cookie'];
    await route.fulfill({ response, headers });
  });
}

async function submit(page: Page) {
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
}

async function a11y(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test('a sign-in whose cookie is dropped shows the blocked-cookie notice and stays on the form', async ({ page }) => {
  await dropSessionCookie(page);
  await page.goto('/');
  await submit(page);
  const notice = page.getByTestId('login-cookie-blocked');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/blocked/i);
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expect(page.getByTestId('sign-out')).toHaveCount(0);
  await expect(page.getByTestId('login-password')).toHaveValue('');
});

test('the login page with the notice passes axe and fits a 390px screen', async ({ page }) => {
  await dropSessionCookie(page);
  await page.goto('/');
  await submit(page);
  await expect(page.getByTestId('login-cookie-blocked')).toBeVisible();
  await a11y(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('login-cookie-blocked')).toBeVisible();
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
  await expect(page.getByTestId('login-cookie-blocked')).toBeInViewport();
});

test('a normal sign-in shows no notice and lands signed in', async ({ page }) => {
  await page.goto('/');
  await submit(page);
  await expectSignedIn(page);
  await expect(page.getByTestId('login-cookie-blocked')).toHaveCount(0);
});

test('?signin=sso while signed out shows the notice and strips the parameter', async ({ page }) => {
  await page.goto('/?signin=sso');
  await expect(page.getByTestId('login-cookie-blocked')).toBeVisible();
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expect.poll(() => page.url()).not.toContain('signin=');
});

test('?signin=sso while signed in shows the app normally and strips the parameter', async ({ page }) => {
  await page.goto('/');
  await submit(page);
  await expectSignedIn(page);

  await page.goto('/?signin=sso');
  await expectSignedIn(page);
  await expect(page.getByTestId('login-cookie-blocked')).toHaveCount(0);
  await expect.poll(() => page.url()).not.toContain('signin=');
});

test('the plain login page has no notice before anything is submitted', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expect(page.getByTestId('login-cookie-blocked')).toHaveCount(0);
});
