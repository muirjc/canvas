import type { BrowserContext, Page } from '@playwright/test';

/**
 * canvas-8em: the Share button only shows when an admin has turned sharing on. That setting is
 * global (one row for the whole app), and specs run in parallel, so specs that need the button
 * answer the editor's settings request for their own page/context instead of flipping the real
 * setting for everyone. Only app-settings.spec.ts changes the real setting.
 */
export async function showShareButton(target: Page | BrowserContext): Promise<void> {
  // Matches /app-settings (what the editor reads), not /admin/app-settings.
  await target.route(/^[^?]*(?<!\/admin)\/app-settings(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { sharingEnabled: true } });
  });
}
