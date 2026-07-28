import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: Page, url = `/?projectId=${PROJECT_ID}`) {
  await page.goto(url);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/**
 * User Story 1 (feature 005): the visual system is actually live, on every screen.
 *
 * These assert computed style rather than appearance — the point is to catch the stylesheet
 * silently failing to load, which would otherwise show up only as a reviewer noticing the app
 * "looks wrong", and which no other test in the suite would detect.
 */
test('the visual system is applied, not browser defaults', async ({ page }) => {
  await page.goto('/');

  // Browser-default body text is serif. Anything containing "Times" means the stylesheet did
  // not load at all — the single most useful signal this suite can give about the redesign.
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toContain('system-ui');
  expect(bodyFont).not.toContain('Times');

  // The app background is the design's surface token, not the browser's white default.
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bodyBg).toBe('rgb(247, 248, 250)');

  // Tokens actually resolve (a missing tokens.css would leave these empty strings).
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  );
  expect(accent).toBe('#2563eb');
});

test('the primary action on each screen is a filled, accented button', async ({ page }) => {
  // Login: the submit button is the screen's primary action.
  await page.goto('/');
  const loginBg = await page
    .getByTestId('login-submit')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(loginBg).toBe('rgb(37, 99, 235)');

  // Home: New Diagram is the primary action, and must be styled identically (FR-002).
  await signIn(page);
  const newDiagramBg = await page
    .getByTestId('new-diagram')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(newDiagramBg).toBe(loginBg);
});

test('every interactive control shows a visible focus indicator', async ({ page }) => {
  await signIn(page);

  // FR-005 is specifically about *keyboard* focus, so this walks the real tab order rather than
  // calling .focus(): programmatic focus does not match :focus-visible in Chromium, so testing
  // it that way would assert something the requirement never claimed.
  await page.locator('body').click({ position: { x: 2, y: 2 } });

  const seen: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return {
        label: el.getAttribute('data-testid') ?? el.tagName.toLowerCase(),
        outlineWidth: s.outlineWidth,
        outlineStyle: s.outlineStyle,
        boxShadow: s.boxShadow,
        matchesFocusVisible: el.matches(':focus-visible'),
      };
    });
    if (!focused) continue;
    seen.push(focused.label);
    const hasRing =
      (focused.outlineStyle !== 'none' && parseFloat(focused.outlineWidth) > 0) ||
      focused.boxShadow !== 'none';
    expect(
      hasRing && focused.matchesFocusVisible,
      `"${focused.label}" has no visible focus indicator on keyboard focus`,
    ).toBe(true);
  }

  // Guard against the loop silently passing because nothing was focusable.
  expect(seen.length, 'tab order reached no focusable control').toBeGreaterThan(3);
});

test('admin screens inherit the visual system without having been edited', async ({ page }) => {
  await signIn(page, '/?admin=users');

  // src/admin/UsersPage.tsx is never touched by this feature — bare-element rules in base.css
  // are what style it (FR-029). If someone converts base.css to class-based styling, this
  // breaks, which is exactly the regression worth catching.
  const th = page.locator('th').first();
  await expect(th).toBeVisible();
  expect(await th.evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase');

  const select = page.locator('select').first();
  await expect(select).toBeVisible();
  // Form controls must use --border-control (3.59:1), never a decorative border token.
  expect(await select.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
    'rgb(126, 136, 150)',
  );
});
