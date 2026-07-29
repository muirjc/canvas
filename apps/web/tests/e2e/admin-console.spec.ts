import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/** The five admin destinations, by the query parameter that reaches them. */
const DESTINATIONS = [
  { param: 'overview', nav: 'admin-nav-overview' },
  { param: 'true', nav: 'admin-nav-standards' },
  { param: 'users', nav: 'admin-nav-users' },
  { param: 'deleted', nav: 'admin-nav-deleted' },
  { param: 'ai-personas', nav: 'admin-nav-ai-personas' },
];

async function signIn(page: Page, email: string, password: string, url: string) {
  await page.goto(url);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

/**
 * User Story 1 (feature 006): the admin console is readable and navigable.
 *
 * Today every admin screen renders flush against the viewport edge with no page container, and an
 * admin can only leave by editing the URL — feature 005 gave these screens tokens but deliberately
 * no layout, and they had none of their own to inherit.
 */
test('every admin screen centres its content with margins on both sides', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=overview');

  for (const { param } of DESTINATIONS) {
    await page.goto(`/?admin=${param}`);
    const shell = page.getByTestId('admin-shell');
    await expect(shell).toBeVisible();

    const box = await shell.boundingBox();
    if (!box) throw new Error(`admin-shell has no bounding box on ?admin=${param}`);

    // FR-001: clear space on BOTH sides, and roughly centred. The current defect is content
    // starting at x=0 with no padding at all.
    const leftMargin = box.x;
    const rightMargin = 1440 - (box.x + box.width);
    expect(leftMargin, `?admin=${param} has no left margin`).toBeGreaterThan(16);
    expect(rightMargin, `?admin=${param} has no right margin`).toBeGreaterThan(16);
    expect(
      Math.abs(leftMargin - rightMargin),
      `?admin=${param} is not centred (left ${leftMargin}, right ${rightMargin})`,
    ).toBeLessThan(4);
  }
});

test('every admin screen offers navigation to every other destination', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=overview');

  for (const { param } of DESTINATIONS) {
    await page.goto(`/?admin=${param}`);
    // FR-002: all five reachable without scrolling.
    for (const { nav } of DESTINATIONS) {
      await expect(page.getByTestId(nav), `${nav} missing on ?admin=${param}`).toBeInViewport();
    }
  }
});

test('the current admin destination is visually distinguishable', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=users');

  // FR-004: exposed to assistive technology as well as visually.
  await expect(page.getByTestId('admin-nav-users')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('admin-nav-overview')).not.toHaveAttribute('aria-current', 'page');
});

test('an admin can get back to the diagrams without editing the URL', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, `/?projectId=${PROJECT_ID}&admin=users`);

  // FR-003: today this route does not exist at all.
  await page.getByTestId('admin-back-to-diagrams').click();
  await expect(page.getByTestId('new-diagram')).toBeVisible();
  await expect(page.getByTestId('admin-shell')).toHaveCount(0);
});

test('adjacent links are visually separated, in the shell nav and inside a screen', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=overview');

  // The shell's own navigation.
  const first = await page.getByTestId('admin-nav-overview').boundingBox();
  const second = await page.getByTestId('admin-nav-standards').boundingBox();
  if (!first || !second) throw new Error('admin nav items have no bounding box');
  expect(second.x - (first.x + first.width), 'shell nav items are touching').toBeGreaterThan(4);

  // FR-005 as actually reported: the Overview screen's OWN links rendered as one run-together
  // string, "Manage StandardsManage Users". That screen is never edited, so only bare-element
  // styling can separate them — which is exactly the regression worth guarding.
  const inner = await page.getByTestId('overview-link-standards').boundingBox();
  const innerNext = await page.getByTestId('overview-link-users').boundingBox();
  if (!inner || !innerNext) throw new Error('overview links have no bounding box');
  expect(
    innerNext.x - (inner.x + inner.width),
    'links inside the Overview screen are touching',
  ).toBeGreaterThan(4);
});

test('a definition list on an unedited admin screen is readable, not a flat run of lines', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/?admin=overview');

  // FR-001: the Overview stats render as a bare <dl>. Term and value must sit on the same line
  // rather than stacking into an undifferentiated column.
  const term = await page.locator('dt').first().boundingBox();
  const value = await page.getByTestId('overview-user-count').boundingBox();
  if (!term || !value) throw new Error('definition list has no bounding box');
  expect(value.x, 'value is not beside its term').toBeGreaterThan(term.x + term.width - 1);
});

test('a non-admin still cannot reach any admin destination', async ({ page }) => {
  await signIn(page, ARCHITECT_EMAIL, ARCHITECT_PASSWORD, `/?projectId=${PROJECT_ID}`);

  for (const { param } of DESTINATIONS) {
    await page.goto(`/?projectId=${PROJECT_ID}&admin=${param}`);
    // FR-006: unchanged from today — the ordinary screen is shown instead.
    await expect(page.getByTestId('admin-shell')).toHaveCount(0);
    await expect(page.getByTestId('new-diagram')).toBeVisible();
  }
});
