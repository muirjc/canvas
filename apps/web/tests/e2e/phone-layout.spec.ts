import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

const PROJECT_ID = process.env.E2E_PROJECT_ID;

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-i08: a page-wide 1280px minimum width (meant for the editor's fixed rails) made every
 * screen 1280px wide on a phone, clipping the create buttons, filters and row actions. Sign-in,
 * the header and the Browse screens must fit a 390px viewport with no horizontal scroll; the
 * editor and the admin console stay desktop-only (ui-design-spec §3.3).
 */

async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page is wider than the viewport').toBeLessThanOrEqual(clientWidth);
}

test.use({ viewport: { width: 390, height: 844 } });

test('sign-in, the project list and a project page fit a phone screen', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByTestId('login-email').fill('admin@example.com');
  await page.getByTestId('login-password').fill('admin-dev-password');
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);

  // A project page: header, breadcrumb, the four create buttons, search/filter, diagram rows.
  await expect(page.getByTestId('project-browser')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expect(page.getByTestId('new-diagram')).toBeInViewport();
  await expect(page.getByTestId('create-via-ai-chat')).toBeInViewport();
  const firstDeleteDiagram = page.locator('[data-testid^="delete-diagram-"]').first();
  if (await firstDeleteDiagram.count()) {
    const box = (await firstDeleteDiagram.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }

  // The project list: toolbar and each row's actions.
  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('projects-page-list')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expect(page.getByTestId('projects-page-start-create')).toBeInViewport();
  await expect(page.getByTestId('sign-out')).toBeInViewport();
});
