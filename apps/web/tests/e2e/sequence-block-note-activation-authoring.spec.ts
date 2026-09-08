import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.E2E_PROJECT_ID;
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

test.skip(!PROJECT_ID, 'E2E_PROJECT_ID env var not set — run `npm run seed` and export it first');

/**
 * canvas-2s6.2: sequence loop/alt/opt/par/critical/break/rect (ranged control-flow blocks),
 * note-left/note-right/note-over, activate/deactivate, and autonumber were all DSL-text-only —
 * no canvas affordance to create any of them ('box' participant grouping was already covered by
 * canvas-2s6.1). Confirms each new affordance actually reaches the model/DSL.
 */

const SEQUENCE_DSL = [
  'sequenceDiagram',
  '  participant A',
  '  participant B',
  '  A->>B: Hello',
  '  B->>A: Hi',
  '  A->>B: Bye',
  '',
].join('\n');

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

test('Activate/Deactivate are disabled with nothing (or more than one) selected', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Activation Disabled', SEQUENCE_DSL);

  await expect(page.getByTestId('activate-participant')).toBeDisabled();
  await expect(page.getByTestId('deactivate-participant')).toBeDisabled();

  await page.getByTestId('node-A').click();
  await expect(page.getByTestId('activate-participant')).toBeEnabled();

  await page.getByTestId('node-B').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('activate-participant')).toBeDisabled();
});

test('clicking Activate on a selected participant produces a real "activate <id>" line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Activate Authoring', SEQUENCE_DSL);

  await page.getByTestId('node-A').click();
  await page.getByTestId('activate-participant').click();

  const source = await dsl(page);
  expect(source).toMatch(/^\s*activate A\s*$/m);
});

test('clicking Deactivate on a selected participant produces a real "deactivate <id>" line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Deactivate Authoring', SEQUENCE_DSL);

  await page.getByTestId('node-B').click();
  await page.getByTestId('deactivate-participant').click();

  const source = await dsl(page);
  expect(source).toMatch(/^\s*deactivate B\s*$/m);
});

test('checking Autonumber produces a bare "autonumber" line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Autonumber Bare', SEQUENCE_DSL);

  await page.getByTestId('sequence-autonumber-toggle').check();
  const source = await dsl(page);
  expect(source).toMatch(/^autonumber\s*$/m);
});

test('setting start/step on Autonumber produces "autonumber <start> <step>"', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Autonumber Start Step', SEQUENCE_DSL);

  await page.getByTestId('sequence-autonumber-toggle').check();
  await page.getByTestId('sequence-autonumber-start').fill('10');
  await page.getByTestId('sequence-autonumber-step').fill('5');

  const source = await dsl(page);
  expect(source).toMatch(/^autonumber 10 5\s*$/m);
});

test('unchecking Autonumber removes the directive entirely', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Autonumber Uncheck', SEQUENCE_DSL);

  await page.getByTestId('sequence-autonumber-toggle').check();
  await expect(await dsl(page)).toContain('autonumber');
  await page.getByTestId('sequence-autonumber-toggle').uncheck();

  const source = await dsl(page);
  expect(source).not.toContain('autonumber');
});

test('Add Note is disabled with nothing selected, and for note-left with two participants selected', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Note Disabled', SEQUENCE_DSL);

  await expect(page.getByTestId('add-sequence-note')).toBeDisabled();

  await page.getByTestId('node-A').click();
  await page.getByTestId('node-B').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('sequence-note-kind')).toHaveValue('note-left');
  await expect(page.getByTestId('add-sequence-note')).toBeDisabled();
});

test('note-left with one participant selected produces a real "Note left of <id>: <text>" line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Note Left Authoring', SEQUENCE_DSL);

  await page.getByTestId('node-A').click();
  await page.getByTestId('sequence-note-kind').selectOption('note-left');
  await page.getByTestId('sequence-note-label').fill('checking status');
  await page.getByTestId('add-sequence-note').click();

  const source = await dsl(page);
  expect(source).toContain('Note left of A: checking status');
});

test('note-over with two participants selected produces a real "Note over A, B: <text>" line', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Note Over Authoring', SEQUENCE_DSL);

  await page.getByTestId('node-A').click();
  await page.getByTestId('node-B').click({ modifiers: ['Shift'] });
  await page.getByTestId('sequence-note-kind').selectOption('note-over');
  await page.getByTestId('sequence-note-label').fill('both busy');
  await page.getByTestId('add-sequence-note').click();

  const source = await dsl(page);
  expect(source).toContain('Note over A, B: both busy');
});

test('Create Block is disabled until at least one message is selected', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Block Disabled', SEQUENCE_DSL);
  await expect(page.getByTestId('create-sequence-block')).toBeDisabled();

  await page.getByTestId('edge-e1').click();
  await expect(page.getByTestId('create-sequence-block')).toBeDisabled();

  await page.getByTestId('edge-e2').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('create-sequence-block')).toBeEnabled();
});

test('Shift+click-selecting the first and last message, then Create Block (Loop), wraps all 3 messages in a real "loop ... end"', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Loop Block Authoring', SEQUENCE_DSL);

  await page.getByTestId('edge-e1').click({ modifiers: ['Shift'] });
  await page.getByTestId('edge-e3').click({ modifiers: ['Shift'] });
  await page.getByTestId('sequence-block-kind').selectOption('loop');
  await page.getByTestId('sequence-block-label').fill('until done');
  await page.getByTestId('create-sequence-block').click();

  const source = await dsl(page);
  expect(source).toMatch(/loop until done\n(.|\n)*end/);
  // The in-between message (e2, not directly clicked) is enclosed too — the whole span, not just
  // the two literally-clicked messages (see createSequenceBlock's own comment for why).
  expect(source).toMatch(/loop until done\n\s*A->>B: Hello\n\s*B->>A: Hi\n\s*A->>B: Bye\n\s*end/);
});

test('Create Block with Kind=Rect produces a real "rect <color> ... end" using the Highlight Color field', async ({ page }) => {
  await login(page);
  await importDsl(page, 'Sequence Rect Block Authoring', SEQUENCE_DSL);

  await page.getByTestId('edge-e1').click({ modifiers: ['Shift'] });
  await page.getByTestId('sequence-block-kind').selectOption('rect');
  await expect(page.getByTestId('sequence-block-color')).toBeVisible();
  await expect(page.getByTestId('sequence-block-label')).toHaveCount(0);
  await page.getByTestId('sequence-block-color').fill('rgb(10, 20, 30)');
  await page.getByTestId('create-sequence-block').click();

  const source = await dsl(page);
  expect(source).toContain('rect rgb(10, 20, 30)');
});
