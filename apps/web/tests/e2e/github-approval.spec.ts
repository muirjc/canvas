import { expect, test, type Page } from '@playwright/test';
import { expectSignedIn } from './auth-helpers';

/**
 * canvas-3s5.1 + canvas-3s5.2: the GitHub approval flow, end to end -- the real web app and real API
 * against the fake GitHub run as its own process (apps/api/tests/helpers/fake-github-server.ts).
 *
 * Needs the API started with GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_API_URL pointing at that
 * fake (CI does; locally see the header of that helper). Skips, with the reason, when GitHub is off or the API is
 * pointed at something other than the fake -- this spec must never drive a real GitHub.
 *
 * The server syncs a pull request from GitHub at most once per 30s (REFRESH_THROTTLE_MS), and the
 * editor's own open/poll syncs count against that. Rather than change the product to suit the test,
 * steps that need fresh GitHub state click Refresh repeatedly until the screen shows it (toPass), so
 * each costs up to ~30s. Hence the long timeout on the main flow.
 *
 * Uses its own project (never E2E_PROJECT_ID), linked to the fake repo and unlinked at the end.
 */
test.describe.configure({ mode: 'serial', timeout: 150_000 });

const API = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const FAKE = `http://127.0.0.1:${process.env.FAKE_GITHUB_PORT ?? '3999'}`;
const REPO = 'canvas-e2e/architecture';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-dev-password';

const RUN = Date.now();
const FOLDER = `e2e-${RUN}`;
const DSL = 'flowchart TD\n  a[Alpha] --> b[Beta]\n';
const DSL_EDITED = 'flowchart TD\n  a[Alpha] --> b[Beta]\n  b --> c[Gamma]\n';

let page: Page;
let skipReason: string | null = null;
let projectId = '';

interface FakePull {
  number: number;
  state: string;
  merged: boolean;
  head: string;
}

async function fakeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${FAKE}${path}`);
  expect(res.status, `fake ${path}`).toBe(200);
  return (await res.json()) as T;
}

async function fakePost(path: string, body: unknown = {}): Promise<void> {
  const res = await fetch(`${FAKE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, `fake ${path}`).toBe(200);
}

const fakePulls = async () => (await fakeGet<{ pulls: FakePull[] }>('/_fake/pulls')).pulls;

async function createDiagram(name: string, dsl = DSL): Promise<string> {
  const created = await page.request.post(`${API}/projects/${projectId}/diagrams`, { data: { name, diagramTypeId: 'flowchart' } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).diagram.id as string;
  expect((await page.request.patch(`${API}/diagrams/${id}`, { data: { dslContent: dsl } })).status()).toBe(200);
  return id;
}

async function openEditor(diagramId: string) {
  await page.goto(`/?diagramId=${diagramId}`);
  await expect(page.getByTestId('diagram-canvas')).toBeVisible();
  await expect(page.getByTestId('submission-chip')).toBeVisible();
}

/** Submit (or push an update) through the confirm dialog; returns the result dialog's title text. */
async function submitThroughDialog(): Promise<string> {
  await page.getByTestId('submission-submit').click();
  await expect(page.getByTestId('submission-confirm')).toBeVisible();
  await page.getByTestId('submission-confirm-submit').click();
  await expect(page.getByTestId('submission-result')).toBeVisible();
  const title = (await page.getByTestId('submission-result').textContent()) ?? '';
  return title;
}

async function closeResult() {
  await page.getByTestId('submission-result-close').click();
  await expect(page.getByTestId('submission-result')).toBeHidden();
}

/** Click Refresh until `assertion` holds -- the server may be inside its 30s throttle window. */
async function refreshUntil(assertion: () => Promise<void>, timeout = 70_000) {
  await expect(async () => {
    const refresh = page.getByTestId('approval-refresh');
    if ((await refresh.count()) > 0 && (await refresh.isEnabled())) await refresh.click();
    await assertion();
  }).toPass({ timeout, intervals: [1_000, 2_000, 3_000, 5_000] });
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto('/');
  await page.getByTestId('login-email').fill(ADMIN_EMAIL);
  await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expectSignedIn(page);

  const status = await page.request.get(`${API}/admin/github/status`);
  if (!status.ok()) {
    skipReason = `GET /admin/github/status returned ${status.status()}: ${await status.text()}`;
    return;
  }
  const body = await status.json();
  if (!body.enabled) {
    skipReason = 'GitHub is not configured on the API (set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_API_URL pointing at the fake GitHub)';
    return;
  }
  if (body.apiUrl !== FAKE) {
    skipReason = `the API's GitHub is ${body.apiUrl}, not the fake at ${FAKE}; refusing to drive it`;
    return;
  }
  try {
    await fakeGet('/_fake/pulls');
  } catch (error) {
    skipReason = `the fake GitHub is not reachable at ${FAKE} (${error instanceof Error ? error.message : String(error)})`;
    return;
  }

  const project = await page.request.post(`${API}/projects`, { data: { name: `GitHub approval ${RUN}` } });
  expect(project.status()).toBe(201);
  projectId = (await project.json()).project.id;
});

test.afterAll(async () => {
  if (projectId) await page.request.delete(`${API}/projects/${projectId}/github-link`);
  await page.context().close();
});

test.beforeEach(() => {
  // CI starts the fake and points the API at it, so a skip there would silently hide this coverage.
  if (process.env.CI && skipReason) throw new Error(`The GitHub approval spec can't run in CI: ${skipReason}`);
  test.skip(skipReason !== null, skipReason ?? '');
});

test('an admin links a project to the repository folder', async () => {
  await page.goto('/?admin=github');
  await expect(page.getByTestId('github-connected')).toBeVisible();
  await page.getByTestId('github-link-project').click();
  await expect(page.getByTestId('github-link-dialog')).toBeVisible();
  await page.getByTestId('github-link-project-select').selectOption(projectId);
  await page.getByTestId('github-link-repo-select').selectOption({ label: `${REPO} (private)` });
  await page.getByTestId('github-link-folder').fill(FOLDER);
  await expect(page.getByTestId('github-link-folder-preview')).toContainText(`${FOLDER}/`);
  await page.getByTestId('github-link-save').click();
  await expect(page.getByTestId('github-link-dialog')).toBeHidden();

  const row = page.getByTestId(`github-link-row-${projectId}`);
  await expect(row).toContainText(REPO);
  await expect(row).toContainText(FOLDER);

  await page.getByTestId(`github-link-test-${projectId}`).click();
  const result = page.getByTestId(`github-test-result-${projectId}`);
  await expect(result).toBeVisible();
  await expect(result).not.toContainText('Failed:');
});

test('submit, update, review, merge: the diagram ends up approved', async () => {
  const diagramId = await createDiagram(`Approval flow ${RUN}`);
  await openEditor(diagramId);
  await expect(page.getByTestId('submission-chip')).toHaveAttribute('data-state', 'not-submitted');

  // Submit for approval -> a pull request on the fake, with the files on its branch.
  await page.getByTestId('submission-submit').click();
  await expect(page.getByTestId('submission-confirm-repo')).toHaveText(REPO);
  await expect(page.getByTestId('submission-confirm-action')).toContainText('opens a new pull request');
  await page.getByTestId('submission-confirm-submit').click();
  await expect(page.getByTestId('submission-result')).toContainText('Created pull request');
  const href = (await page.getByTestId('submission-result-link').getAttribute('href')) ?? '';
  const prNumber = Number(href.match(/\/pull\/(\d+)$/)?.[1]);
  expect(prNumber).toBeGreaterThan(0);
  await closeResult();
  await expect(page.getByTestId('submission-chip')).toHaveAttribute('data-state', 'in-review');
  await expect(page.getByTestId('submission-chip')).toContainText(`PR #${prNumber}`);

  const pull = (await fakePulls()).find((p) => p.number === prNumber)!;
  expect(pull.state).toBe('open');
  const filesOf = async () => (await fakeGet<{ files: Record<string, string> }>(`/_fake/files?branch=${encodeURIComponent(pull.head)}`)).files;
  let files = await filesOf();
  const source = Object.keys(files).find((p) => p.startsWith(`${FOLDER}/`) && p.endsWith('.canvas.mmd'));
  expect(source, `files on the PR branch: ${Object.keys(files).join(', ')}`).toBeTruthy();
  expect(Object.keys(files).some((p) => p.startsWith(`${FOLDER}/`) && p.endsWith('/README.md'))).toBe(true);
  expect(files[source!]).toContain('Alpha');
  expect(files[source!]).not.toContain('Gamma');

  // Edit + save -> the chip says the PR is behind the diagram, and the button now pushes an update.
  await page.getByTestId('dsl-panel').fill(DSL_EDITED);
  await page.getByTestId('apply-dsl').click();
  await expect(page.getByTestId('node-c')).toBeVisible();
  await page.getByTestId('save-diagram').click();
  await expect(page.getByTestId('save-status')).toHaveText('saved');
  await expect(page.getByTestId('submission-chip')).toHaveAttribute('data-state', 'changed');
  await expect(page.getByTestId('submission-chip')).toHaveText('Changes since submitting');
  await expect(page.getByTestId('submission-submit')).toHaveText(`Push update to PR #${prNumber}`);

  // Push update -> the same pull request, a new commit.
  await page.getByTestId('submission-submit').click();
  await expect(page.getByTestId('submission-confirm-action')).toContainText(`open pull request #${prNumber}`);
  await page.getByTestId('submission-confirm-submit').click();
  await expect(page.getByTestId('submission-result')).toContainText(`Updated pull request #${prNumber}`);
  await closeResult();
  await expect(page.getByTestId('submission-chip')).toHaveAttribute('data-state', 'in-review');
  const open = (await fakePulls()).filter((p) => p.state === 'open' && p.head === pull.head);
  expect(open.map((p) => p.number)).toEqual([prNumber]);
  files = await filesOf();
  expect(files[source!]).toContain('Gamma');

  // A review and a passing check on GitHub show up in the Approval tab after a refresh.
  await fakePost(`/_fake/pulls/${prNumber}/reviews`, { login: 'reviewer-one', state: 'APPROVED' });
  await fakePost(`/_fake/pulls/${prNumber}/check-runs`, { name: 'validate-diagram', conclusion: 'success' });
  await page.getByTestId('rail-tab-approval').click();
  await expect(page.getByTestId('approval-panel')).toBeVisible();
  await expect(page.getByTestId('approval-pr-state')).toHaveText('open');
  await refreshUntil(async () => {
    await expect(page.getByTestId('approval-review-reviewer-one')).toContainText('Approved', { timeout: 1_000 });
    await expect(page.getByTestId('approval-check-validate-diagram')).toHaveAttribute('data-state', 'success', { timeout: 1_000 });
  });
  await expect(page.getByTestId('approval-review-summary')).toHaveText('Approved');

  // Merge on GitHub -> approved, with the version that was last pushed.
  await fakePost(`/_fake/pulls/${prNumber}/merge`, { by: 'reviewer-one' });
  await refreshUntil(async () => {
    await expect(page.getByTestId('submission-chip')).toHaveAttribute('data-state', 'approved', { timeout: 1_000 });
  });
  await expect(page.getByTestId('submission-chip')).toHaveText(/^Approved \(version \d+\)$/);
  await expect(page.getByTestId('approval-approved')).toContainText('merged by @reviewer-one');
  await expect(page.getByTestId('approval-approved-link')).toContainText(`PR #${prNumber}`);

  // The project page badge agrees.
  await page.goto(`/?projectId=${projectId}`);
  const badge = page.getByTestId('submission-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute('data-state', 'approved');
  await expect(badge).toHaveText(/^Approved v\d+$/);
});

test('withdrawing a submission closes the pull request', async () => {
  const diagramId = await createDiagram(`Withdraw flow ${RUN}`);
  await openEditor(diagramId);
  await submitThroughDialog();
  await closeResult();
  await expect(page.getByTestId('submission-chip')).toHaveAttribute('data-state', 'in-review');
  const prNumber = Number((await page.getByTestId('submission-chip').textContent())?.match(/PR #(\d+)/)?.[1]);

  await page.getByTestId('rail-tab-approval').click();
  await page.getByTestId('approval-withdraw').click();
  await expect(page.getByTestId('approval-withdraw-confirm')).toBeVisible();
  await page.getByTestId('approval-withdraw-confirm-button').click();

  await expect(page.getByTestId('approval-withdraw-confirm')).toBeHidden();
  await expect(page.getByTestId('submission-chip')).toHaveAttribute('data-state', 'withdrawn');
  await expect(page.getByTestId('approval-withdrawn')).toBeVisible();
  const pull = (await fakePulls()).find((p) => p.number === prNumber)!;
  expect(pull.state).toBe('closed');
  expect(pull.merged).toBe(false);
});
