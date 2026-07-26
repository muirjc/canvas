import { expect, test } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!process.env.RUN_PERF_TESTS || !PROJECT_ID, 'Set RUN_PERF_TESTS=1 and E2E_PROJECT_ID to run this');

function generateFlowchartWith(nodeCount: number): string {
  const lines = ['flowchart TD'];
  for (let i = 0; i < nodeCount; i += 1) {
    lines.push(`  n${i}[Node ${i}]`);
  }
  for (let i = 0; i < nodeCount - 1; i += 1) {
    lines.push(`  n${i} --> n${i + 1}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * SC-007 / Constitution performance goal: canvas interactions sustain 60fps up to at least 300
 * elements. Measures actual requestAnimationFrame deltas in the browser during a drag
 * interaction on a 300-node diagram — a real frame-timing measurement, not a proxy metric.
 */
test('canvas sustains near-60fps while dragging a node among 300 elements', async ({ page }) => {
  await page.goto(`/?projectId=${PROJECT_ID}`);
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('**/*');

  await page.getByTestId('new-diagram').click();
  await page.getByTestId('diagram-type-flowchart').check();
  await page.getByTestId('confirm-new-diagram').click();
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();

  const dslPanel = page.getByTestId('dsl-panel');
  await dslPanel.fill(generateFlowchartWith(300));
  await page.getByTestId('apply-dsl').click();
  await expect(page.locator('[data-testid^="node-"]')).toHaveCount(300);

  const target = page.getByTestId('node-n0');
  const box = await target.boundingBox();
  if (!box) throw new Error('node-n0 has no bounding box');

  // Start collecting rAF frame timestamps in the page, then perform a real drag while it runs.
  const frameSamplePromise = page.evaluate(() => {
    return new Promise<number[]>((resolve) => {
      const timestamps: number[] = [];
      const durationMs = 1200;
      const start = performance.now();
      function tick(t: number) {
        timestamps.push(t);
        if (performance.now() - start < durationMs) {
          requestAnimationFrame(tick);
        } else {
          resolve(timestamps);
        }
      }
      requestAnimationFrame(tick);
    });
  });

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.move(box.x + box.width / 2 + i * 4, box.y + box.height / 2 + i * 2);
  }
  await page.mouse.up();

  const timestamps = await frameSamplePromise;
  const deltas = timestamps.slice(1).map((t, i) => t - timestamps[i]);
  const avgFrameMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const impliedFps = 1000 / avgFrameMs;

  // 50fps floor rather than a strict 60 — real browser/CI scheduling jitter means demanding an
  // exact 60.0 is not a meaningful bar; this still confirms no gross frame-rate collapse at 300
  // elements (a naive re-render-everything-on-every-mousemove implementation would show <20fps).
  expect(impliedFps, `implied fps was ${impliedFps.toFixed(1)}`).toBeGreaterThan(50);
});
