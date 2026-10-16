import { expect, type Locator } from '@playwright/test';

/**
 * Perform the connect-mode gesture: click `first`, wait until the canvas has committed it as the
 * connection source, then click `second`. Without the wait, the second click can land before the
 * first click's state is rendered and no edge is created (canvas-whz).
 */
export async function connectShapes(first: Locator, second: Locator): Promise<void> {
  await first.click();
  await expect(first).toHaveAttribute('data-connect-source', 'true');
  await second.click();
}
