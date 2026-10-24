import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { buildGitHubTestApp, startFakeGitHub, type FakeGitHub, type FakeRepo } from '../helpers/fake-github.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-3s5.1: submitting a diagram to GitHub as a pull request, against an in-memory fake GitHub.
 * One open PR per diagram; submitting again pushes a new commit to the same PR; merged/closed PRs
 * are noticed on the next submit.
 */
type Who = 'admin' | 'owner' | 'viewer' | 'commenter' | 'editor';

const FRONT_MATTER = '---\ncanvas:\n  positions:\n    A:\n      x: 40\n      y: 40\n    B:\n      x: 240\n      y: 40\n---\n';
const DSL = `${FRONT_MATTER}flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n`;
const DSL_V2 = `${FRONT_MATTER}flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n  B --> C[Invoice]:::step\n`;

const ONE_STEP_DSL = `---\ncanvas:\n  positions:\n    A:\n      x: 40\n      y: 40\n---\nflowchart TD\n  A[Only one]:::step\n`;

const STANDARD = {
  name: 'Order process rules',
  description: 'Steps for order flows.',
  requireKnownKinds: true,
  elementKinds: [{ id: 'step', label: 'Step', shapes: ['rectangle'], approvedFills: [], minCount: 2 }],
  severityOverrides: { 'kind-min-count': 'error' },
};

describe('Submitting diagrams to GitHub (canvas-3s5.1)', () => {
  let fake: FakeGitHub;
  let app: FastifyInstance;
  let repo: FakeRepo;
  let otherRepo: FakeRepo;
  let projectId = '';
  const cookies = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;

  async function login(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, who: Who = 'owner', payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: cookies[who] }, payload: payload as object });

  async function createDiagram(name = 'Order Flow', dsl: string | undefined = DSL): Promise<string> {
    const res = await call('POST', `/projects/${projectId}/diagrams`, 'owner', { name, diagramTypeId: 'flowchart', initialDslContent: dsl });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().diagram.id as string;
  }
  async function save(diagramId: string, dsl: string) {
    const res = await call('PATCH', `/diagrams/${diagramId}`, 'owner', { dslContent: dsl });
    expect(res.statusCode, res.body).toBe(200);
  }
  const saved = async (diagramId: string) => (await call('GET', `/diagrams/${diagramId}`)).json().diagram.dslContent as string;
  const submit = (diagramId: string, who: Who = 'owner') => call('POST', `/diagrams/${diagramId}/submissions`, who);
  const status = async (diagramId: string, who: Who = 'owner') => (await call('GET', `/diagrams/${diagramId}/submission`, who)).json();
  const id8 = (diagramId: string) => diagramId.replace(/-/g, '').slice(0, 8);
  async function publishStandard(body: object = STANDARD) {
    const created = await call('POST', '/diagram-types/flowchart/standards', 'admin', body);
    expect(created.statusCode, created.body).toBe(201);
    expect((await call('POST', `/standards/${created.json().standard.id}/publish`, 'admin')).statusCode).toBe(200);
  }
  async function linkProject(folder = 'architecture', target: FakeRepo = repo, project = projectId) {
    const res = await call('PUT', `/projects/${project}/github-link`, 'admin', { repoId: target.id, folder });
    expect(res.statusCode, res.body).toBe(200);
  }
  const submissionRows = (diagramId: string) => getDb().selectFrom('diagram_submissions').selectAll().where('diagram_id', '=', diagramId).orderBy('first_submitted_at').execute();

  beforeAll(async () => {
    fake = await startFakeGitHub();
    app = await buildGitHubTestApp(fake);
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
    await fake.stop();
  });
  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    fake.clearRecords();
    fake.installations.clear();
    fake.repos.clear();
    fake.latencyMs = 0;
    fake.failWith = null;
    fake.beforeRefUpdate = undefined;
    const installation = fake.addInstallation({ account: 'acme' });
    repo = fake.addRepo(installation.id, { name: 'architecture' });
    otherRepo = fake.addRepo(installation.id, { name: 'elsewhere' });

    const users: [Who, string, 'admin' | 'architect'][] = [
      ['admin', 'Adam Admin', 'admin'],
      ['owner', 'Olivia <Owner>', 'architect'],
      ['viewer', 'Vera Viewer', 'architect'],
      ['commenter', 'Cody Commenter', 'architect'],
      ['editor', 'Edie Editor', 'architect'],
    ];
    for (const [who, name, role] of users) {
      ids[who] = (await seedUser({ email: `${who}@example.com`, name, password: `${who}-pass`, role })).id; // gitleaks:allow
      cookies[who] = await login(`${who}@example.com`, `${who}-pass`); // gitleaks:allow
    }
    projectId = (await seedProject('Orders', ids.owner)).id;
  });

  async function shareAll(diagramId: string) {
    for (const [who, level] of [['viewer', 'view'], ['commenter', 'comment'], ['editor', 'edit']] as const) {
      expect((await call('POST', `/diagrams/${diagramId}/shares`, 'owner', { granteeUserId: ids[who], accessLevel: level })).statusCode).toBe(201);
    }
  }

  describe('who can submit and when', () => {
    it('an unlinked project answers 409 not_linked and touches nothing on GitHub', async () => {
      const diagramId = await createDiagram();
      const res = await submit(diagramId);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not_linked');
      expect(fake.requests).toEqual([]);
      expect((await status(diagramId)).canSubmit).toMatchObject({ allowed: false, reason: 'not_linked' });
    });

    it('view-only and comment-only users get 403; an edit-shared user may submit; no cookie is 401', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await shareAll(diagramId);
      expect((await submit(diagramId, 'viewer')).statusCode).toBe(403);
      expect((await submit(diagramId, 'commenter')).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/diagrams/${diagramId}/submissions` })).statusCode).toBe(401);
      expect(repo.pulls.size).toBe(0);

      expect((await status(diagramId, 'viewer')).canSubmit).toMatchObject({ allowed: false, reason: 'no_edit_access' });
      expect((await status(diagramId, 'editor')).canSubmit).toMatchObject({ allowed: true, reason: null });

      const res = await submit(diagramId, 'editor');
      expect(res.statusCode, res.body).toBe(201);
      // The co-author is the person who clicked Submit.
      expect(fake.commitsOn(repo, res.json().submission.branch)[0].message).toContain('Co-authored-by: Edie Editor <editor@example.com>');
    });

    it('a Must fix issue from the active standard answers 422 with the violations and creates nothing', async () => {
      await linkProject();
      await publishStandard();
      const diagramId = await createDiagram('Too small', ONE_STEP_DSL);

      const check = await status(diagramId);
      expect(check.canSubmit).toMatchObject({ allowed: false, reason: 'must_fix' });
      expect(check.canSubmit.mustFixCount).toBeGreaterThan(0);

      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().code).toBe('must_fix');
      expect(res.json().violations.length).toBeGreaterThan(0);
      expect(res.json().violations[0]).toMatchObject({ severity: 'error', rule: 'kind-min-count', message: expect.stringContaining('Step') });
      expect([...repo.branches.keys()]).toEqual(['main']);
      expect(repo.pulls.size).toBe(0);
      expect(await submissionRows(diagramId)).toEqual([]);
    });

    it('warnings do not block, and are listed in the pull request description', async () => {
      await linkProject();
      await publishStandard({ ...STANDARD, severityOverrides: { 'kind-min-count': 'warning' } });
      const diagramId = await createDiagram('Warned', ONE_STEP_DSL);
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().warnings.length).toBeGreaterThan(0);
      expect(fake.pull(repo, 1).body).toContain('Standard findings');
      expect((await status(diagramId)).canSubmit).toMatchObject({ allowed: true, warningCount: res.json().warnings.length, mustFixCount: 0 });
    });
  });

  describe('first submission', () => {
    it('creates the branch, one commit (co-authored), the files and the pull request', async () => {
      await linkProject();
      await publishStandard();
      const diagramId = await createDiagram();
      const dsl = await saved(diagramId);
      expect(dsl).toContain('canvas:');

      const mainBefore = fake.headOf(repo, 'main');
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      const { outcome, submission } = res.json();
      const branch = `canvas/${id8(diagramId)}-order-flow-r1`;
      expect(outcome).toBe('created');
      expect(submission).toMatchObject({
        state: 'open',
        prNumber: 1,
        branch,
        path: 'architecture/order-flow',
        baseBranch: 'main',
        repoFullName: 'acme/architecture',
        submittedBy: 'Olivia <Owner>',
        submittedVersionSequence: expect.any(Number),
      });
      expect(submission.prUrl).toBe('https://github.test/acme/architecture/pull/1');

      // One commit on top of the base branch, crediting the Canvas user; the base branch itself is untouched.
      expect(fake.headOf(repo, 'main')).toBe(mainBefore);
      const commits = fake.commitsOn(repo, branch);
      expect(commits).toHaveLength(2);
      expect(commits[1].sha).toBe(mainBefore);
      expect(commits[0].message).toContain('Submit "Order Flow"');
      expect(commits[0].message).toContain('Co-authored-by: Olivia Owner <owner@example.com>');

      const pull = fake.pull(repo, 1);
      expect(pull).toMatchObject({ head: branch, base: 'main', state: 'open' });
      expect(pull.title).toContain('Order Flow');
      expect(pull.body).toContain('http://canvas.test/?diagramId=');
      expect(pull.body).toContain(`canvas:diagram=${diagramId}`);

      const files = fake.files(repo, branch)!;
      expect([...files.keys()].sort()).toEqual([
        '.canvas/standards/flowchart/v1.json',
        'README.md',
        'architecture/order-flow/README.md',
        'architecture/order-flow/canvas.json',
        'architecture/order-flow/order-flow.canvas.mmd',
        'architecture/order-flow/order-flow.mmd',
        'architecture/order-flow/order-flow.svg',
      ]);
      expect(files.get('architecture/order-flow/order-flow.canvas.mmd')).toBe(dsl);
      const portable = files.get('architecture/order-flow/order-flow.mmd')!;
      expect(portable).not.toContain('canvas:');
      expect(portable).toContain('flowchart TD');
      expect(portable).toContain('Receive order');
      expect(files.get('architecture/order-flow/order-flow.svg')).toMatch(/^<svg[\s\S]*Receive order/);
      const readme = files.get('architecture/order-flow/README.md')!;
      expect(readme).toContain('(./order-flow.svg)');
      expect(readme).toContain('```mermaid');
      const manifest = JSON.parse(files.get('architecture/order-flow/canvas.json')!);
      expect(manifest).toMatchObject({
        schema: 1,
        diagramId,
        name: 'Order Flow',
        diagramType: 'flowchart',
        dslFamily: 'flowchart',
        source: 'order-flow.canvas.mmd',
        portable: 'order-flow.mmd',
        svg: 'order-flow.svg',
        standard: { path: '.canvas/standards/flowchart/v1.json', version: 1, name: 'Order process rules' },
        canvasUrl: `http://canvas.test/?diagramId=${diagramId}`,
      });
      expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      const standard = JSON.parse(files.get('.canvas/standards/flowchart/v1.json')!);
      expect(standard).toMatchObject({ diagramTypeId: 'flowchart', version: 1, name: 'Order process rules' });
      expect(standard.rules.elementKinds[0].id).toBe('step');

      // The installation token was narrowed to the one repository and the permissions a submission uses.
      const tokenRequest = fake.tokenRequests.at(-1)!;
      expect(tokenRequest.body.repository_ids).toEqual([repo.id]);
      expect(tokenRequest.body.permissions).toEqual({ contents: 'write', pull_requests: 'write', metadata: 'read' });

      // Recorded: the push, the audit event.
      const rows = await submissionRows(diagramId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'open', pr_number: 1, last_pushed_commit_sha: commits[0].sha, head_sha: commits[0].sha, submitting_since: null });
      const pushes = await getDb().selectFrom('diagram_submission_pushes').selectAll().execute();
      expect(pushes).toMatchObject([{ submission_id: rows[0].id, commit_sha: commits[0].sha, pushed_by_user_id: ids.owner }]);
      const audit = await getDb().selectFrom('audit_events').select(['event', 'actor_user_id', 'detail']).where('event', '=', 'diagram_submitted').execute();
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(ids.owner);
      expect(String(audit[0].detail)).toContain('acme/architecture');
    });

    it('omits the standard file when the diagram type has no active standard', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      const files = [...fake.files(repo, res.json().submission.branch)!.keys()];
      expect(files.some((f) => f.startsWith('.canvas/'))).toBe(false);
      expect(JSON.parse(fake.files(repo, res.json().submission.branch)!.get('architecture/order-flow/canvas.json')!).standard).toBeNull();
    });

    it('escapes Markdown in the diagram name (README and pull request) so it cannot mention or format', async () => {
      await linkProject();
      const diagramId = await createDiagram('@everyone **x**');
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      const { branch, path } = res.json().submission;
      expect(path).toBe('architecture/everyone-x');
      const readme = fake.files(repo, branch)!.get(`${path}/README.md`)!;
      const body = fake.pull(repo, 1).body;
      for (const text of [readme, body]) {
        expect(text).not.toContain('@everyone');
        expect(text).not.toContain('**x**');
      }
      expect(readme).toContain('\\*\\*x\\*\\*');
      expect(body).toContain('\\*\\*x\\*\\*');
      // The title is plain text (GitHub does not render or notify from titles), but never carries a line break.
      expect(fake.pull(repo, 1).title.includes('\n')).toBe(false);
    });

    it('a second diagram with the same name gets an -<id8> suffix and its own folder', async () => {
      await linkProject();
      const first = await createDiagram('Order Flow');
      const second = await createDiagram('Order Flow');
      expect((await submit(first)).json().submission.path).toBe('architecture/order-flow');
      const res = await submit(second);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().submission.path).toBe(`architecture/order-flow-${id8(second)}`);
      expect(res.json().submission.branch).toMatch(new RegExp(`^canvas/${id8(second)}-order-flow-${id8(second)}-r1$`));
      // Both diagrams' files coexist; neither overwrote the other.
      const files = [...fake.files(repo, res.json().submission.branch)!.keys()];
      expect(files).not.toContain('architecture/order-flow/canvas.json'); // the first lives on its own branch, not this one
      expect(files).toContain(`architecture/order-flow-${id8(second)}/canvas.json`);
    });

    it('uses a different branch name when a stale branch of the planned name already exists', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const planned = `canvas/${id8(diagramId)}-order-flow-r1`;
      fake.repos.get(repo.id)!.branches.set(planned, fake.headOf(repo, 'main'));
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().submission.branch).toMatch(new RegExp(`^${planned}-[0-9a-f]{4}$`));
      expect(fake.pull(repo, 1).head).toBe(res.json().submission.branch);
    });
  });

  describe('submitting again', () => {
    it('with nothing changed is upToDate: no new commit, no new pull request', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      const head = fake.headOf(repo, first.branch);
      fake.clearRecords();

      const again = await submit(diagramId);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().outcome).toBe('upToDate');
      expect(again.json().submission).toMatchObject({ prNumber: 1, state: 'open' });
      expect(fake.headOf(repo, first.branch)).toBe(head);
      expect(fake.callsTo('POST', /git\/commits$/)).toEqual([]);
      expect(fake.callsTo('PATCH', /./)).toEqual([]);
      expect(repo.pulls.size).toBe(1);
      expect(await getDb().selectFrom('diagram_submission_pushes').select('id').execute()).toHaveLength(1);
      expect((await submissionRows(diagramId))[0].submitting_since).toBeNull();
    });

    it('after a save pushes one more commit to the same pull request (200 updated)', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      const firstHead = fake.headOf(repo, first.branch);
      await save(diagramId, DSL_V2);

      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().outcome).toBe('updated');
      expect(res.json().submission).toMatchObject({ prNumber: 1, branch: first.branch, path: first.path });
      expect(res.json().submission.submittedVersionSequence).toBeGreaterThan(first.submittedVersionSequence);

      const commits = fake.commitsOn(repo, first.branch);
      expect(commits).toHaveLength(3);
      expect(commits[1].sha).toBe(firstHead);
      expect(commits[0].message).toContain('Update "Order Flow"');
      expect(commits[0].message).toContain('Co-authored-by: Olivia Owner <owner@example.com>');
      expect(fake.files(repo, first.branch)!.get('architecture/order-flow/order-flow.canvas.mmd')).toBe(await saved(diagramId));
      expect(fake.files(repo, first.branch)!.get('architecture/order-flow/order-flow.mmd')).toContain('Invoice');

      expect(repo.pulls.size).toBe(1);
      expect(fake.pull(repo, 1).title).toContain(`version ${res.json().submission.submittedVersionSequence}`);
      const rows = await submissionRows(diagramId);
      expect(rows).toHaveLength(1);
      expect(rows[0].last_pushed_commit_sha).toBe(commits[0].sha);
      const pushes = await getDb().selectFrom('diagram_submission_pushes').select(['commit_sha', 'version_sequence']).orderBy('version_sequence').execute();
      expect(pushes.map((p) => p.commit_sha)).toEqual([firstHead, commits[0].sha]);
      const audit = await getDb().selectFrom('audit_events').select('id').where('event', '=', 'diagram_submitted').execute();
      expect(audit).toHaveLength(2);
    });

    it('reports changesSinceSubmitting after a save (and after a rename), and clears it on resubmit', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      expect((await status(diagramId)).current).toBeNull();
      expect((await status(diagramId)).changesSinceSubmitting).toBe(false);
      await submit(diagramId);

      let view = await status(diagramId);
      expect(view).toMatchObject({ enabled: true, link: { repoFullName: 'acme/architecture', folder: 'architecture', baseBranch: 'main' }, changesSinceSubmitting: false });
      expect(view.current).toMatchObject({ state: 'open', prNumber: 1 });
      expect(view.current.fingerprint).toBeUndefined();

      await save(diagramId, DSL_V2);
      expect((await status(diagramId)).changesSinceSubmitting).toBe(true);
      expect((await submit(diagramId)).json().outcome).toBe('updated');
      expect((await status(diagramId)).changesSinceSubmitting).toBe(false);

      expect((await call('PATCH', `/diagrams/${diagramId}/name`, 'owner', { name: 'Renamed' })).statusCode).toBe(200);
      view = await status(diagramId);
      expect(view.changesSinceSubmitting).toBe(true);
      // A rename is not propagated: the folder and branch stay where they were first submitted.
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().submission.path).toBe('architecture/order-flow');
    });
  });

  describe('a pull request merged or closed on GitHub', () => {
    it('merged, then a changed diagram opens a new pull request (-r2) at the same path', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      fake.mergePull(repo, 1);
      await save(diagramId, DSL_V2);

      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().outcome).toBe('created');
      expect(res.json().submission).toMatchObject({ prNumber: 2, state: 'open', path: first.path, branch: `canvas/${id8(diagramId)}-order-flow-r2` });
      const rows = await submissionRows(diagramId);
      expect(rows.map((r) => [r.pr_number, r.state])).toEqual([[1, 'merged'], [2, 'open']]);
      expect(rows[0].merged_by_login).toBe('reviewer');
      expect(Boolean(rows[0].merged_head_matches)).toBe(true); // SQLite stores booleans as 0/1
      // The second branch started from the merged base, so it carries only the new change.
      expect(fake.commitsOn(repo, `canvas/${id8(diagramId)}-order-flow-r2`)[1].sha).toBe(fake.headOf(repo, 'main'));
      expect(fake.pull(repo, 2).base).toBe('main');
    });

    it('merged and unchanged: the base already has the files, so the old row is marked merged and nothing new opens', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      fake.mergePull(repo, 1);

      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'upToDate', submission: null });
      expect(repo.pulls.size).toBe(1);
      expect((await status(diagramId)).current).toMatchObject({ state: 'merged', prNumber: 1, mergedBy: 'reviewer' });
      expect((await submissionRows(diagramId)).filter((r) => r.state === 'open')).toEqual([]);
    });

    it('merged without applying to the base branch (e.g. squash-merged elsewhere) opens -r2 even if unchanged', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      fake.mergePull(repo, 1, { applyToBase: false });

      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().submission).toMatchObject({ prNumber: 2, branch: `canvas/${id8(diagramId)}-order-flow-r2`, path: 'architecture/order-flow' });
    });

    it('closed unmerged then submit opens a new pull request and records the old one as closed', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      fake.closePull(repo, 1);

      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().submission.prNumber).toBe(2);
      const rows = await submissionRows(diagramId);
      expect(rows.map((r) => [r.pr_number, r.state])).toEqual([[1, 'closed'], [2, 'open']]);
      expect(rows[0].merged_head_matches).toBeNull();
    });

    it('merged with edits made on GitHub is flagged (merged_head_matches false)', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      const outside = fake.makeCommit(repo, fake.headOf(repo, first.branch), { 'architecture/order-flow/README.md': 'edited by hand\n' });
      fake.forceMoveBranch(repo, first.branch, outside);
      fake.mergePull(repo, 1);
      await save(diagramId, DSL_V2);
      await submit(diagramId);
      const [row] = await submissionRows(diagramId);
      expect(row.state).toBe('merged');
      expect(row.merged_head_matches).not.toBeNull();
      expect(Boolean(row.merged_head_matches)).toBe(false);
    });
  });

  describe('races and conflicts', () => {
    it('two simultaneous first submits: exactly one pull request; the other gets 409 in_progress', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      fake.latencyMs = 30;
      const results = await Promise.all([submit(diagramId), submit(diagramId)]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes, results.map((r) => r.body).join('\n')).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('in_progress');
      fake.latencyMs = 0;
      expect(repo.pulls.size).toBe(1);
      expect([...repo.branches.keys()].filter((b) => b.startsWith('canvas/'))).toHaveLength(1);
      const rows = await submissionRows(diagramId);
      expect(rows).toHaveLength(1);
      expect(rows[0].submitting_since).toBeNull();
    });

    it('two simultaneous updates: exactly one commit is pushed; the other gets 409 in_progress', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      await save(diagramId, DSL_V2);
      fake.latencyMs = 30;
      const results = await Promise.all([submit(diagramId), submit(diagramId)]);
      fake.latencyMs = 0;
      expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join('\n')).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('in_progress');
      expect(fake.commitsOn(repo, first.branch)).toHaveLength(3);
      expect(repo.pulls.size).toBe(1);
      expect((await submissionRows(diagramId))[0].submitting_since).toBeNull();
    });

    it('a lock left by a request that died stops blocking after two minutes', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      await save(diagramId, DSL_V2);
      await getDb().updateTable('diagram_submissions').set({ submitting_since: new Date() }).where('diagram_id', '=', diagramId).execute();
      expect((await submit(diagramId)).json().code).toBe('in_progress');
      await getDb().updateTable('diagram_submissions').set({ submitting_since: new Date(Date.now() - 3 * 60_000) }).where('diagram_id', '=', diagramId).execute();
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().outcome).toBe('updated');
    });

    it('a stale lock does not hide that the pull request was merged: the merge is recorded and a new PR opens', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      fake.mergePull(repo, 1, { applyToBase: false });
      await getDb().updateTable('diagram_submissions').set({ submitting_since: new Date(Date.now() - 3 * 60_000) }).where('diagram_id', '=', diagramId).execute();
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().submission.prNumber).toBe(2);
      expect((await submissionRows(diagramId)).map((r) => [r.pr_number, r.state])).toEqual([[1, 'merged'], [2, 'open']]);
    });

    it('the branch moving during the push is a 409 conflict, releases the lock, and a retry succeeds', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      await save(diagramId, DSL_V2);
      const sibling = fake.makeCommit(repo, fake.headOf(repo, 'main'), { 'unrelated.txt': 'x' });
      fake.beforeRefUpdate = (r, branch) => {
        fake.beforeRefUpdate = undefined; // once
        fake.forceMoveBranch(r, branch, sibling);
      };
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('conflict');
      expect((await submissionRows(diagramId))[0].submitting_since).toBeNull();

      // Canvas never force-pushes: the moved branch is left as GitHub has it.
      expect(fake.headOf(repo, first.branch)).toBe(sibling);
      const retry = await submit(diagramId);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().outcome).toBe('updated');
      expect(fake.files(repo, first.branch)!.get('architecture/order-flow/order-flow.mmd')).toContain('Invoice');
      expect(fake.files(repo, first.branch)!.get('unrelated.txt')).toBe('x');
    });

    it('a branch deleted on GitHub is a 409 conflict with the lock released; restoring it lets the next submit work', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      await save(diagramId, DSL_V2);
      const head = fake.headOf(repo, first.branch);
      fake.deleteBranch(repo, first.branch);

      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('conflict');
      expect((await submissionRows(diagramId))[0].submitting_since).toBeNull();

      fake.forceMoveBranch(repo, first.branch, head);
      const retry = await submit(diagramId);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json().outcome).toBe('updated');
    });

    it('a force-pushed branch is built on, never overwritten (Canvas does not force-push)', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      await save(diagramId, DSL_V2);
      const rewritten = fake.makeCommit(repo, fake.headOf(repo, 'main'), { 'note.txt': 'someone force-pushed' });
      fake.forceMoveBranch(repo, first.branch, rewritten);
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(200);
      expect(fake.commitsOn(repo, first.branch)[1].sha).toBe(rewritten);
      expect(fake.callsTo('PATCH', /git\/refs/).every((r) => (r.body as { force: boolean }).force === false)).toBe(true);
    });

    it('moving the link to another repository while a pull request is open is 409 link_changed', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      await linkProject('architecture', otherRepo);
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('link_changed');
      expect(otherRepo.pulls.size).toBe(0);
      expect([...otherRepo.branches.keys()]).toEqual(['main']);
      expect((await submissionRows(diagramId))[0]).toMatchObject({ state: 'open', submitting_since: null });
    });

    it('moving the link to another folder while a pull request is open is also 409 link_changed', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      await linkProject('docs/diagrams');
      expect((await submit(diagramId)).json().code).toBe('link_changed');
    });

    it('a deleted base branch is 409 not_linked and leaves no half-made submission behind', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      fake.deleteBranch(repo, 'main');
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('not_linked');
      expect(await submissionRows(diagramId)).toEqual([]);
    });
  });

  describe('GitHub failures', () => {
    it('GitHub being down is a 502, leaves no provisional submission, and the next submit works', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      fake.failWith = { status: 500 };
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(502);
      fake.failWith = null;
      expect(await submissionRows(diagramId)).toEqual([]);
      expect((await submit(diagramId)).statusCode).toBe(201);
    });

    it('a rate limit is a 503 github_rate_limited', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      fake.failWith = { status: 403, headers: { 'x-ratelimit-remaining': '0' } };
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().code).toBe('github_rate_limited');
      fake.failWith = null;
    });

    it('the App losing its installation is a 502 github_access, not a crash', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      fake.removeRepoFromInstallation(repo);
      const res = await submit(diagramId);
      expect(res.statusCode, res.body).toBe(502);
      expect(res.json().code).toBe('github_access');
      expect(await submissionRows(diagramId)).toEqual([]);
    });

    it('never puts a token in an error response', async () => {
      await linkProject();
      const diagramId = await createDiagram();
      await submit(diagramId);
      fake.removeInstallation(repo.installationId);
      const res = await submit(diagramId);
      expect(res.body).not.toMatch(/ghs_|Bearer |-----BEGIN/);
    });
  });
});
