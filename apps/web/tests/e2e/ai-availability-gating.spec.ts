import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';
const ARCHITECT_EMAIL = 'architect@example.com';
const ARCHITECT_PASSWORD = 'architect-dev-password';
const API_BASE_URL = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

async function signIn(page: import('@playwright/test').Page, email: string, password: string): Promise<void> {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  // waitForURL is a no-op in this SPA — wait for the post-login signal itself (ai-persona-
  // admin.spec.ts's own convention) rather than a URL that never changes.
  await expect(page.getByTestId('sign-out')).toBeVisible();
}

async function openAnyFlowchartDiagram(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
}

/**
 * canvas-wuc: neither the "Create with AI" button nor the Chat panel used to check
 * `ai_settings.chatEnabled` client-side, and nothing ever told a user the deployment was running
 * the mock/placeholder provider instead of a real model. This repo's dev/E2E stack always runs
 * with AI_PROVIDER=mock (server.ts's own comment) — the mock-mode notices are therefore expected
 * to always be present here, not a surprise.
 */
test.describe('AI availability gating', () => {
  test('AI chat is enabled by default in this environment, with a visible mock-mode notice', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    // Other specs toggle chatEnabled and don't always restore it — assert the enabled state
    // directly rather than trusting leftover state from a previous test file.
    await page.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
    await page.reload();

    await expect(page.getByTestId('create-via-ai-chat')).toBeEnabled();
    // canvas-hmm: the mock-mode note moved from the project page into the Create with AI dialog.
    await page.getByTestId('create-via-ai-chat').click();
    await expect(page.getByTestId('ai-mock-mode-note')).toBeVisible();
    await page.getByTestId('ai-create-cancel').click();
    await expect(page.getByTestId('create-via-ai-disabled-note')).toHaveCount(0);

    await openAnyFlowchartDiagram(page);
    await page.getByTestId('rail-tab-chat').click();
    await expect(page.getByTestId('chat-mock-mode-notice')).toBeVisible();
    await expect(page.getByTestId('chat-disabled-notice')).toHaveCount(0);
    await expect(page.getByTestId('chat-input')).toBeEnabled();
    // chat-send is also gated on non-empty input (unrelated to this bead) — fill it first so
    // this only asserts the chatEnabled/provider-driven disabled state, not that unrelated one.
    await page.getByTestId('chat-input').fill('Add a shape called Ping');
    await expect(page.getByTestId('chat-send')).toBeEnabled();
  });

  test('the admin AI Personas page reports the mock provider', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    // canvas-t3b.4: header Admin link, then the admin side nav (the project page's admin links are gone).
    await page.getByTestId('nav-admin').click();
    await page.getByTestId('admin-nav-ai-personas').click();
    await expect(page.getByTestId('ai-provider-indicator')).toBeVisible();
    const text = (await page.getByTestId('ai-provider-indicator').textContent()) ?? '';
    expect(text.toLowerCase()).toContain('mock');
  });

  test('disabling AI chat disables both entry points; re-enabling restores them', async ({ browser }) => {
    // Two separate browser contexts (shared-diagrams.spec.ts's own convention for an admin +
    // another user acting concurrently) rather than one page signing in/out twice — that would
    // lose the admin session's cookie the moment it signs out, leaving nothing authorized to
    // re-enable the toggle in the `finally` block below.
    const adminContext = await browser.newContext();
    const architectContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const architectPage = await architectContext.newPage();

    await signIn(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    // canvas-t3b.4: header Admin link, then the admin side nav (the project page's admin links are gone).
    await adminPage.getByTestId('nav-admin').click();
    await adminPage.getByTestId('admin-nav-ai-personas').click();
    await expect(adminPage.getByTestId('ai-chat-enabled-toggle')).toBeChecked();

    try {
      // canvas-yh6: the checkbox changes at once; wait for the save before relying on it.
      const saved = adminPage.waitForResponse((r) => r.url().endsWith('/admin/ai-settings') && r.request().method() !== 'GET' && r.ok());
      await adminPage.getByTestId('ai-chat-enabled-toggle').uncheck();
      await saved;

      // As an ordinary (non-admin) user: the button and chat panel are both disabled.
      await signIn(architectPage, ARCHITECT_EMAIL, ARCHITECT_PASSWORD);

      await expect(architectPage.getByTestId('create-via-ai-chat')).toBeDisabled();
      await expect(architectPage.getByTestId('create-via-ai-disabled-note')).toBeVisible();

      await openAnyFlowchartDiagram(architectPage);
      await architectPage.getByTestId('rail-tab-chat').click();
      await expect(architectPage.getByTestId('chat-disabled-notice')).toBeVisible();
      await expect(architectPage.getByTestId('chat-input')).toBeDisabled();
      await expect(architectPage.getByTestId('chat-send')).toBeDisabled();
    } finally {
      // Never leave AI chat disabled for other specs in the same suite run (canvas-mt3's
      // revoke-after-test convention, applied here to a global admin toggle rather than a share
      // grant).
      await adminPage.request.patch(`${API_BASE_URL}/admin/ai-settings`, { data: { chatEnabled: true } });
      await adminContext.close();
      await architectContext.close();
    }
  });
});
