import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * jmuir-dzd.5 (grouping G, the last deferred item under jmuir-dzd): flowchart `click <id> href
 * "<url>" ["<tooltip>"] [_blank]` had no canvas UI at all — only reachable by hand-editing the DSL
 * panel. A new per-node Link affordance/popup (flowchart-only, mirroring the existing style/kind
 * popups' pattern) can set, edit, and clear it. The one MANDATORY requirement: a disallowed href
 * scheme (the "javascript:" XSS-payload case) must be refused client-side with a visible error,
 * never silently saved.
 */

const FLOWCHART_DSL = ['flowchart TD', '  a[A]', ''].join('\n');

async function login(page: Page) {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');
}

async function importDsl(page: Page, name: string, source: string) {
  await page.getByTestId('import-diagram-button').click();
  await page.getByTestId('import-name').fill(name);
  await page.getByTestId('import-textarea').fill(source);
  await page.getByTestId('confirm-import').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

async function dsl(page: Page): Promise<string> {
  await page.getByTestId('rail-tab-dsl').click();
  return page.getByTestId('dsl-panel').inputValue();
}

test('the link affordance is offered for flowchart', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Affordance Visible', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await expect(page.getByTestId('edit-link-a')).toBeVisible();
});

test('the link affordance is absent for a non-flowchart family (C4)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Affordance Absent', 'C4Context\n  Person(user, "User")\n');

  await page.getByTestId('node-user').hover();
  await expect(page.getByTestId('edit-link-user')).toHaveCount(0);
});

test('setting a URL produces a real "click <id> href" line in the DSL', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Set', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('https://example.com');
  await page.getByTestId('link-save-a').click();

  const source = await dsl(page);
  expect(source).toContain('click a href "https://example.com"');
});

test('setting a tooltip and "Open in new tab" produces the full form of the line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Set Full', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('https://example.com');
  await page.getByTestId('link-tooltip-a').fill('Visit site');
  await page.getByTestId('link-target-a').check();
  await page.getByTestId('link-save-a').click();

  const source = await dsl(page);
  expect(source).toContain('click a href "https://example.com" "Visit site" _blank');
});

test('reopening the popup on an already-linked node shows its current URL/tooltip/target', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Reopen', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('https://example.com');
  await page.getByTestId('link-tooltip-a').fill('Visit site');
  await page.getByTestId('link-target-a').check();
  await page.getByTestId('link-save-a').click();

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await expect(page.getByTestId('link-href-a')).toHaveValue('https://example.com');
  await expect(page.getByTestId('link-tooltip-a')).toHaveValue('Visit site');
  await expect(page.getByTestId('link-target-a')).toBeChecked();
});

test('Clear removes the link entirely', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Clear', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('https://example.com');
  await page.getByTestId('link-save-a').click();
  expect(await dsl(page)).toContain('click a href');

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-clear-a').click();

  const source = await dsl(page);
  expect(source).not.toContain('click a href');
});

test('Escape closes the popup without saving', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Escape', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('https://example.com');
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('link-href-a')).toHaveCount(0);
  expect(await dsl(page)).not.toContain('click a href');
});

// The one mandatory requirement (bd show jmuir-dzd's own design decision): the href scheme
// allowlist must be enforced, not just documented — a disallowed scheme is refused, visibly, right
// where the user typed it, never silently saved.
test('a "javascript:" URL is refused with a visible error, never saved (the XSS-payload case)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link XSS Rejected', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('javascript:alert(document.cookie)');
  await page.getByTestId('link-save-a').click();

  await expect(page.getByTestId('link-error-a')).toBeVisible();
  // The popup stays open (the save did not succeed) and the DSL was never touched.
  await expect(page.getByTestId('link-href-a')).toBeVisible();
  expect(await dsl(page)).not.toContain('click');
});

test('a "data:" URL is likewise refused', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Data URL Rejected', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('data:text/html,<script>alert(1)</script>');
  await page.getByTestId('link-save-a').click();

  await expect(page.getByTestId('link-error-a')).toBeVisible();
  expect(await dsl(page)).not.toContain('click');
});

// appsec review (jmuir-dzd.5): a URL obfuscated with a leading space bypassed an earlier version
// of isAllowedLinkHref (the WHATWG URL parser strips leading C0-control-or-space before scheme
// detection, but the old hand-rolled regex didn't) -- confirms the fix reaches the actual popup a
// real user types into, not just the underlying unit function.
test('a "javascript:" URL obfuscated by a leading space is also refused', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Leading Space Rejected', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill(' javascript:alert(document.cookie)');
  await page.getByTestId('link-save-a').click();

  await expect(page.getByTestId('link-error-a')).toBeVisible();
  expect(await dsl(page)).not.toContain('click');
});

// appsec review (jmuir-dzd.5): the DSL "click href" directive's `"..."` token has no escape
// syntax for an embedded quote -- an unescaped one would prematurely close the token and could
// inject a separate DSL statement, so it must be refused client-side too, not just at the
// underlying setNodeLink op.
test('a URL containing a double-quote is refused (no escape syntax in the DSL token)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Quote Rejected', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('https://example.com/"><script>alert(1)</script>');
  await page.getByTestId('link-save-a').click();

  await expect(page.getByTestId('link-error-a')).toBeVisible();
  expect(await dsl(page)).not.toContain('click');
});

test('a relative path is accepted (not just http/https)', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Click Link Relative Path', FLOWCHART_DSL);

  await page.getByTestId('node-a').hover();
  await page.getByTestId('edit-link-a').click();
  await page.getByTestId('link-href-a').fill('/docs/getting-started');
  await page.getByTestId('link-save-a').click();

  const source = await dsl(page);
  expect(source).toContain('click a href "/docs/getting-started"');
});
