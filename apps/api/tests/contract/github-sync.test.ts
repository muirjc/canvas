import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { GitHubClient } from '../../src/github/github-client.js';
import { REFRESH_THROTTLE_MS, syncOpenSubmissions } from '../../src/github/status-sync.service.js';
import { buildGitHubTestApp, githubTestConfig, startFakeGitHub, type FakeGitHub, type FakeRepo } from '../helpers/fake-github.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-3s5.2: keeping Canvas's view of a submitted diagram's pull request current -- merged
 * (approved), closed (rejected), reviews, checks -- plus withdrawing, history and project badges.
 */
type Who = 'admin' | 'owner' | 'viewer' | 'editor' | 'stranger';

const FRONT_MATTER = '---\ncanvas:\n  positions:\n    A:\n      x: 40\n      y: 40\n    B:\n      x: 240\n      y: 40\n---\n';
const DSL = `${FRONT_MATTER}flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n`;
const DSL_V2 = `${FRONT_MATTER}flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n  B --> C[Invoice]:::step\n`;

describe('GitHub pull request status sync (canvas-3s5.2)', () => {
  let fake: FakeGitHub;
  let app: FastifyInstance;
  let repo: FakeRepo;
  let otherRepo: FakeRepo;
  let installationId = 0;
  let projectId = '';
  let client: GitHubClient;
  const cookies = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;

  async function login(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, who: Who = 'owner', payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: cookies[who] }, payload: payload as object });

  async function createDiagram(name = 'Order Flow', project = projectId): Promise<string> {
    const res = await call('POST', `/projects/${project}/diagrams`, 'owner', { name, diagramTypeId: 'flowchart', initialDslContent: DSL });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().diagram.id as string;
  }
  async function save(diagramId: string, dsl: string) {
    expect((await call('PATCH', `/diagrams/${diagramId}`, 'owner', { dslContent: dsl })).statusCode).toBe(200);
  }
  async function linkProject(folder = 'architecture', target: FakeRepo = repo, project = projectId) {
    const res = await call('PUT', `/projects/${project}/github-link`, 'admin', { repoId: target.id, folder });
    expect(res.statusCode, res.body).toBe(200);
  }
  /** A linked project with one submitted diagram (PR #1 on `repo`). */
  async function submitted(name = 'Order Flow') {
    const diagramId = await createDiagram(name);
    const res = await call('POST', `/diagrams/${diagramId}/submissions`);
    expect(res.statusCode, res.body).toBe(201);
    return { diagramId, branch: res.json().submission.branch as string, number: res.json().submission.prNumber as number };
  }
  const refresh = async (diagramId: string, who: Who = 'owner') => call('POST', `/diagrams/${diagramId}/submission/refresh`, who);
  const current = async (diagramId: string, who: Who = 'owner') => (await refresh(diagramId, who)).json();
  const rows = (diagramId: string) => getDb().selectFrom('diagram_submissions').selectAll().where('diagram_id', '=', diagramId).orderBy('first_submitted_at').execute();
  const events = (event: string) => getDb().selectFrom('audit_events').select(['event', 'actor_user_id', 'detail']).where('event', '=', event).execute();
  /** Pretends the last sync was a while ago, so the throttle / job's minimum age don't apply. */
  const ageSync = (diagramId: string, ms = REFRESH_THROTTLE_MS + 5_000) =>
    getDb().updateTable('diagram_submissions').set({ last_synced_at: new Date(Date.now() - ms) }).where('diagram_id', '=', diagramId).execute();
  const headSha = (diagramId: string, branch: string) => {
    void diagramId;
    return fake.headOf(repo, branch);
  };

  beforeAll(async () => {
    fake = await startFakeGitHub();
    app = await buildGitHubTestApp(fake);
    client = new GitHubClient(githubTestConfig(fake).github!);
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
    const installation = fake.addInstallation({ account: 'acme' });
    installationId = installation.id;
    repo = fake.addRepo(installation.id, { name: 'architecture' });
    otherRepo = fake.addRepo(installation.id, { name: 'elsewhere' });
    client = new GitHubClient(githubTestConfig(fake).github!); // fresh token cache per test

    const users: [Who, string, 'admin' | 'architect'][] = [
      ['admin', 'Adam Admin', 'admin'],
      ['owner', 'Olivia <Owner>', 'architect'],
      ['viewer', 'Vera Viewer', 'architect'],
      ['editor', 'Edie Editor', 'architect'],
      ['stranger', 'Sam Stranger', 'architect'],
    ];
    for (const [who, name, role] of users) {
      ids[who] = (await seedUser({ email: `${who}@example.com`, name, password: `${who}-pass`, role })).id; // gitleaks:allow
      cookies[who] = await login(`${who}@example.com`, `${who}-pass`); // gitleaks:allow
    }
    projectId = (await seedProject('Orders', ids.owner)).id;
    await linkProject();
  });

  describe('refresh: merged, closed', () => {
    it('merged on GitHub: state merged, approved populated, head matches', async () => {
      const { diagramId, number } = await submitted();
      fake.mergePull(repo, number, { by: 'rita' });
      const body = await current(diagramId);
      expect(body.current).toMatchObject({ state: 'merged', prNumber: number, mergedBy: 'rita', mergedHeadMatches: true });
      expect(body.current.mergedAt).toBeTruthy();
      expect(body.approved).toMatchObject({ state: 'merged', submittedVersionSequence: 1, mergedBy: 'rita', mergedHeadMatches: true });
      expect(body.approved.mergedAt).toBeTruthy();
      expect(body.canWithdraw).toBe(false);
    });

    it('merged after an extra commit was pushed on GitHub: mergedHeadMatches is false', async () => {
      const { diagramId, branch, number } = await submitted();
      const outside = fake.makeCommit(repo, fake.headOf(repo, branch), { 'architecture/order-flow/README.md': 'edited by hand\n' });
      fake.forceMoveBranch(repo, branch, outside);
      fake.mergePull(repo, number);
      const body = await current(diagramId);
      expect(body.current).toMatchObject({ state: 'merged', mergedHeadMatches: false });
      expect(body.approved).toMatchObject({ mergedHeadMatches: false });
    });

    it('closed without merging: state closed (rejected), nothing approved', async () => {
      const { diagramId, number } = await submitted();
      fake.closePull(repo, number);
      const body = await current(diagramId);
      expect(body.current).toMatchObject({ state: 'closed', mergedBy: null, mergedHeadMatches: null, withdrawnAt: null });
      expect(body.current.closedAt).toBeTruthy();
      expect(body.approved).toBeNull();
      expect(body.canWithdraw).toBe(false);
      expect(await events('diagram_submission_closed')).toHaveLength(1);
    });

    it('records diagram_submission_merged exactly once even when refreshed twice', async () => {
      const { diagramId, number } = await submitted();
      fake.mergePull(repo, number);
      await refresh(diagramId);
      await refresh(diagramId);
      const merged = await events('diagram_submission_merged');
      expect(merged).toHaveLength(1);
      expect(String(merged[0].detail)).toContain('acme/architecture');
      expect(await events('diagram_submission_closed')).toHaveLength(0);
    });
  });

  describe('refresh: reviews', () => {
    async function reviewState(setup: (number: number) => void) {
      const { diagramId, number } = await submitted();
      setup(number);
      return (await current(diagramId)).current;
    }

    it('no reviews: none', async () => {
      expect(await reviewState(() => undefined)).toMatchObject({ state: 'open', reviewState: 'none' });
    });

    it('APPROVED, then a later COMMENTED from the same reviewer, keeps approved', async () => {
      const cur = await reviewState((n) => {
        fake.addReview(repo, n, 'ann', 'APPROVED');
        fake.addReview(repo, n, 'ann', 'COMMENTED');
      });
      expect(cur.reviewState).toBe('approved');
      expect(cur.statusDetail.reviews).toEqual([{ login: 'ann', state: 'APPROVED' }]);
    });

    it('CHANGES_REQUESTED from anyone wins over another reviewer approving', async () => {
      const cur = await reviewState((n) => {
        fake.addReview(repo, n, 'ann', 'APPROVED');
        fake.addReview(repo, n, 'bob', 'CHANGES_REQUESTED');
      });
      expect(cur.reviewState).toBe('changes_requested');
    });

    it('a reviewer who changes their mind: their latest decision counts', async () => {
      const cur = await reviewState((n) => {
        fake.addReview(repo, n, 'bob', 'CHANGES_REQUESTED');
        fake.addReview(repo, n, 'bob', 'APPROVED');
      });
      expect(cur.reviewState).toBe('approved');
    });

    it('DISMISSED removes the decision', async () => {
      const cur = await reviewState((n) => {
        fake.addReview(repo, n, 'bob', 'CHANGES_REQUESTED');
        fake.addReview(repo, n, 'bob', 'DISMISSED');
      });
      expect(cur.reviewState).toBe('none');
      expect(cur.statusDetail.reviews).toEqual([]);
    });

    it('outstanding review requests (people and teams) make it pending, listed in statusDetail', async () => {
      const cur = await reviewState((n) => {
        fake.addReview(repo, n, 'ann', 'APPROVED');
        fake.requestReviewer(repo, n, 'carl');
        fake.requestTeam(repo, n, 'architects');
      });
      expect(cur.reviewState).toBe('pending');
      expect(cur.statusDetail.requestedReviewers).toEqual(['carl', 'team:architects']);
      expect(cur.statusDetail.reviews).toEqual([{ login: 'ann', state: 'APPROVED' }]);
    });

    it('requested changes still win over an outstanding request', async () => {
      const cur = await reviewState((n) => {
        fake.addReview(repo, n, 'bob', 'CHANGES_REQUESTED');
        fake.requestReviewer(repo, n, 'carl');
      });
      expect(cur.reviewState).toBe('changes_requested');
    });

    it('reads past the first page of 100 reviews', async () => {
      const cur = await reviewState((n) => {
        for (let i = 0; i < 100; i++) fake.addReview(repo, n, `noise${i}`, 'COMMENTED');
        fake.addReview(repo, n, 'late', 'CHANGES_REQUESTED');
      });
      expect(cur.reviewState).toBe('changes_requested');
    });
  });

  describe('refresh: checks', () => {
    async function checksFor(setup: (sha: string) => void, grant = true) {
      if (grant) fake.grantChecks(installationId);
      const { diagramId, branch } = await submitted();
      setup(headSha(diagramId, branch));
      return (await current(diagramId)).current;
    }

    it('a failing check run: failure, with names and urls in statusDetail', async () => {
      const cur = await checksFor((sha) =>
        fake.setCheckRuns(repo, sha, [
          { name: 'lint', status: 'completed', conclusion: 'success' },
          { name: 'build', status: 'completed', conclusion: 'failure' },
        ]),
      );
      expect(cur.checksState).toBe('failure');
      expect(cur.statusDetail.checks).toEqual([
        { name: 'lint', state: 'success', url: 'https://github.test/run/lint' },
        { name: 'build', state: 'failure', url: 'https://github.test/run/build' },
      ]);
    });

    it('a check still running: pending', async () => {
      const cur = await checksFor((sha) => fake.setCheckRuns(repo, sha, [{ name: 'lint', status: 'in_progress', conclusion: null }]));
      expect(cur.checksState).toBe('pending');
    });

    it('all passing (a skipped run does not fail it; a commit status counts too): success', async () => {
      const cur = await checksFor((sha) => {
        fake.setCheckRuns(repo, sha, [
          { name: 'lint', status: 'completed', conclusion: 'success' },
          { name: 'optional', status: 'completed', conclusion: 'skipped' },
        ]);
        fake.setStatuses(repo, sha, [{ context: 'legacy-ci', state: 'success' }]);
      });
      expect(cur.checksState).toBe('success');
      expect(cur.statusDetail.checks.map((c: { name: string }) => c.name)).toEqual(['lint', 'optional', 'legacy-ci']);
    });

    it('a legacy commit status in error: failure', async () => {
      const cur = await checksFor((sha) => fake.setStatuses(repo, sha, [{ context: 'legacy-ci', state: 'error' }]));
      expect(cur.checksState).toBe('failure');
    });

    it('no checks at all: none', async () => {
      expect((await checksFor(() => undefined)).checksState).toBe('none');
    });

    it('checks permission not granted (403): unavailable, but reviews and the rest still sync', async () => {
      const { diagramId, number } = await submitted();
      fake.addReview(repo, number, 'ann', 'APPROVED');
      const cur = (await current(diagramId)).current;
      expect(cur).toMatchObject({ state: 'open', checksState: 'unavailable', reviewState: 'approved', lastSyncError: null });
      expect(cur.statusDetail.checks).toEqual([]);
      expect(cur.lastSyncedAt).toBeTruthy();
    });

    it('a check run for an older commit is not counted: the head commit is what is asked about', async () => {
      fake.grantChecks(installationId);
      const { diagramId, branch } = await submitted();
      const oldSha = fake.headOf(repo, branch);
      fake.setCheckRuns(repo, oldSha, [{ name: 'build', status: 'completed', conclusion: 'failure' }]);
      await save(diagramId, DSL_V2);
      expect((await call('POST', `/diagrams/${diagramId}/submissions`)).statusCode).toBe(200);
      expect(fake.headOf(repo, branch)).not.toBe(oldSha);
      await ageSync(diagramId);
      expect((await current(diagramId)).current.checksState).toBe('none');
    });
  });

  describe('refresh: throttle, errors, access', () => {
    it('a second refresh within 30s makes no GitHub calls; after the window it asks again', async () => {
      const { diagramId } = await submitted();
      await refresh(diagramId);
      fake.clearRecords();
      const again = await refresh(diagramId);
      expect(again.statusCode).toBe(200);
      expect(fake.requests).toEqual([]);

      await ageSync(diagramId);
      await refresh(diagramId);
      expect(fake.callsTo('GET', /\/pulls\/1$/).length).toBe(1);
    });

    it('a refresh with nothing submitted makes no calls and answers the status', async () => {
      const diagramId = await createDiagram();
      fake.clearRecords();
      const res = await refresh(diagramId);
      expect(res.statusCode).toBe(200);
      expect(res.json().current).toBeNull();
      expect(fake.requests).toEqual([]);
    });

    it('access lost: lastSyncError is set and the link says "Needs attention"', async () => {
      const { diagramId } = await submitted();
      fake.removeRepoFromInstallation(repo);
      const res = await refresh(diagramId);
      expect(res.statusCode).toBe(200);
      expect(res.json().current.lastSyncError).toBeTruthy();
      expect(res.json().current.state).toBe('open');
      const links = (await call('GET', '/admin/github/links', 'admin')).json().links;
      expect(links[0].lastCheckError).toMatch(/^Needs attention: /);

      // It recovers once access is back.
      fake.addRepoToInstallation(repo);
      await ageSync(diagramId);
      expect((await current(diagramId)).current.lastSyncError).toBeNull();
    });

    it('a GitHub outage is recorded on the submission, not thrown, and the link is not flagged', async () => {
      const { diagramId } = await submitted();
      fake.failWith = { status: 500 };
      const res = await refresh(diagramId);
      expect(res.statusCode).toBe(200);
      expect(res.json().current.lastSyncError).toBeTruthy();
      fake.failWith = null;
      const links = (await call('GET', '/admin/github/links', 'admin')).json().links;
      expect(links[0].lastCheckError ?? '').not.toMatch(/Needs attention/);
    });

    it('a view-only user can refresh but cannot withdraw; a stranger can do neither', async () => {
      const { diagramId, number } = await submitted();
      expect((await call('POST', `/diagrams/${diagramId}/shares`, 'owner', { granteeUserId: ids.viewer, accessLevel: 'view' })).statusCode).toBe(201);
      expect((await refresh(diagramId, 'viewer')).statusCode).toBe(200);
      const view = await call('GET', `/diagrams/${diagramId}/submission`, 'viewer');
      expect(view.json().canWithdraw).toBe(false);
      expect((await call('POST', `/diagrams/${diagramId}/submission/withdraw`, 'viewer')).statusCode).toBe(403);
      expect(fake.pull(repo, number).state).toBe('open');
      expect((await refresh(diagramId, 'stranger')).statusCode).toBe(403);
      expect((await call('POST', `/diagrams/${diagramId}/submission/withdraw`, 'stranger')).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/diagrams/${diagramId}/submission/refresh` })).statusCode).toBe(401);
    });
  });

  describe('syncOpenSubmissions (the scheduled job)', () => {
    it('syncs every open submission, returning counts, and skips recently synced ones', async () => {
      const a = await submitted('Alpha');
      const b = await submitted('Beta');
      const c = await submitted('Gamma');
      fake.mergePull(repo, a.number);
      fake.closePull(repo, b.number);
      fake.addReview(repo, c.number, 'ann', 'APPROVED');

      const counts = await syncOpenSubmissions(client);
      expect(counts).toEqual({ open: 1, merged: 1, closed: 1, error: 0, skipped: 0, rateLimited: 0 });
      expect((await rows(a.diagramId))[0].state).toBe('merged');
      expect((await rows(b.diagramId))[0].state).toBe('closed');
      const [rowC] = await rows(c.diagramId);
      expect(rowC).toMatchObject({ state: 'open', review_state: 'approved' });

      // Only the still-open one is a candidate, and it was just synced.
      fake.clearRecords();
      expect(await syncOpenSubmissions(client)).toEqual({ open: 0, merged: 0, closed: 0, error: 0, skipped: 0, rateLimited: 0 });
      expect(fake.requests).toEqual([]);

      // A zero minimum age syncs it regardless.
      expect((await syncOpenSubmissions(client, 0)).open).toBe(1);
    });

    it('one failing submission does not stop the others', async () => {
      await linkProject('other', otherRepo, (await seedProject('Other', ids.owner)).id);
      const otherProject = (await getDb().selectFrom('github_links').select('project_id').where('repo_id', '=', otherRepo.id).executeTakeFirstOrThrow()).project_id;
      const bad = await createDiagram('Bad', otherProject);
      expect((await call('POST', `/diagrams/${bad}/submissions`)).statusCode).toBe(201);
      const good = await submitted('Good');
      fake.addReview(repo, good.number, 'ann', 'APPROVED');
      fake.removeRepoFromInstallation(otherRepo);

      const counts = await syncOpenSubmissions(client);
      expect(counts).toMatchObject({ open: 1, error: 1 });
      expect((await rows(bad))[0].last_sync_error).toBeTruthy();
      expect((await rows(good.diagramId))[0].review_state).toBe('approved');
    });

    it('canvas-3s5.4: a rate limit stops the batch (the rest wait for the next run) and later calls skip GitHub', async () => {
      const a = await submitted('Alpha');
      const b = await submitted('Beta');
      const c = await submitted('Gamma');
      const limited = new GitHubClient({ appId: fake.appId, privateKey: fake.privateKey, apiUrl: fake.url });
      fake.failWith = { status: 429, headers: { 'retry-after': '600' } };
      fake.clearRecords();

      const counts = await syncOpenSubmissions(limited, 0);
      expect(counts).toEqual({ open: 0, merged: 0, closed: 0, error: 0, skipped: 2, rateLimited: 1 });
      // One attempt reached GitHub; the batch stopped there.
      expect(fake.requests.length).toBeLessThanOrEqual(1);
      const errors = (await Promise.all([a, b, c].map(async (s) => (await rows(s.diagramId))[0].last_sync_error))).filter(Boolean);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/rate limit/i);

      // Still inside the back-off: nothing is sent at all, and the link isn't flagged as broken.
      fake.failWith = null;
      fake.clearRecords();
      expect((await syncOpenSubmissions(limited, 0)).rateLimited).toBe(1);
      expect(fake.requests).toEqual([]);
      const link = await getDb().selectFrom('github_links').select('last_check_error').where('repo_id', '=', repo.id).executeTakeFirstOrThrow();
      expect(link.last_check_error ?? '').not.toMatch(/Needs attention/);
    });

    it('a diagram that was never submitted, or a submission that failed to open, is not a candidate', async () => {
      await createDiagram('Never submitted');
      fake.clearRecords();
      expect(await syncOpenSubmissions(client)).toEqual({ open: 0, merged: 0, closed: 0, error: 0, skipped: 0, rateLimited: 0 });
      expect(fake.requests).toEqual([]);
    });
  });

  describe('withdraw', () => {
    const withdraw = (diagramId: string, who: Who = 'owner') => call('POST', `/diagrams/${diagramId}/submission/withdraw`, who);

    it('comments who withdrew, closes the PR, records who and when, and audits it', async () => {
      const { diagramId, number } = await submitted();
      const res = await withdraw(diagramId);
      expect(res.statusCode, res.body).toBe(200);
      expect(fake.pull(repo, number)).toMatchObject({ state: 'closed', merged: false });
      expect(fake.pull(repo, number).comments).toEqual(['Withdrawn in Canvas by Olivia <Owner>.']);
      const body = res.json();
      expect(body.current).toMatchObject({ state: 'closed', withdrawnBy: 'Olivia <Owner>' });
      expect(body.current.withdrawnAt).toBeTruthy();
      expect(body.canWithdraw).toBe(false);
      expect(body.approved).toBeNull();
      const audit = await events('diagram_submission_withdrawn');
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_user_id).toBe(ids.owner);
      expect(await events('diagram_submission_closed')).toHaveLength(0);
    });

    it('the comment cannot @-mention people or span lines via the user name', async () => {
      const { diagramId, number } = await submitted();
      await getDb().updateTable('users').set({ name: 'Eve @octocat\nsecond line' }).where('id', '=', ids.owner).execute();
      expect((await withdraw(diagramId)).statusCode).toBe(200);
      const [comment] = fake.pull(repo, number).comments;
      expect(comment).not.toMatch(/@octocat/);
      expect(comment).not.toContain('\n');
    });

    it('an edit-shared user may withdraw', async () => {
      const { diagramId } = await submitted();
      await call('POST', `/diagrams/${diagramId}/shares`, 'owner', { granteeUserId: ids.editor, accessLevel: 'edit' });
      const res = await withdraw(diagramId, 'editor');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().current.withdrawnBy).toBe('Edie Editor');
    });

    it('nothing open: 409 not_open and nothing is sent to GitHub', async () => {
      const diagramId = await createDiagram();
      fake.clearRecords();
      const res = await withdraw(diagramId);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not_open');
      expect(fake.requests).toEqual([]);
    });

    it('withdrawing twice: the second is 409 not_open and adds no second comment', async () => {
      const { diagramId, number } = await submitted();
      expect((await withdraw(diagramId)).statusCode).toBe(200);
      expect((await withdraw(diagramId)).statusCode).toBe(409);
      expect(fake.pull(repo, number).comments).toHaveLength(1);
    });

    it('already merged on GitHub: 409 not_open, nothing is closed or commented, and the merge is recorded', async () => {
      const { diagramId, number } = await submitted();
      fake.mergePull(repo, number, { by: 'rita' });
      const res = await withdraw(diagramId);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('not_open');
      expect(res.json().error).toContain('merged');
      expect(fake.pull(repo, number).comments).toEqual([]);
      const [row] = await rows(diagramId);
      expect(row).toMatchObject({ state: 'merged', merged_by_login: 'rita', withdrawn_at: null });
      expect(await events('diagram_submission_merged')).toHaveLength(1);
      expect(await events('diagram_submission_withdrawn')).toHaveLength(0);
    });

    it('already closed on GitHub: 409 not_open and it is recorded as closed, not withdrawn', async () => {
      const { diagramId, number } = await submitted();
      fake.closePull(repo, number);
      const res = await withdraw(diagramId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('closed');
      expect((await rows(diagramId))[0]).toMatchObject({ state: 'closed', withdrawn_at: null });
      expect(await events('diagram_submission_withdrawn')).toHaveLength(0);
    });

    it('after withdrawing, a new submit opens a new pull request', async () => {
      const { diagramId } = await submitted();
      await withdraw(diagramId);
      await save(diagramId, DSL_V2);
      const res = await call('POST', `/diagrams/${diagramId}/submissions`);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().submission).toMatchObject({ state: 'open', prNumber: 2, withdrawnAt: null });
      expect((await rows(diagramId)).map((r) => [r.pr_number, r.state])).toEqual([[1, 'closed'], [2, 'open']]);
    });

    it('with GitHub switched off the route answers 409 github_disabled', async () => {
      const off = await buildGitHubTestApp(null);
      try {
        const diagramId = await createDiagram();
        const res = await off.inject({ method: 'POST', url: `/diagrams/${diagramId}/submission/withdraw`, headers: { cookie: cookies.owner } });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('github_disabled');
      } finally {
        await off.close();
      }
    });
  });

  describe('history', () => {
    it('lists pull requests newest first, each with its pushes newest first', async () => {
      const { diagramId } = await submitted();
      await save(diagramId, DSL_V2);
      expect((await call('POST', `/diagrams/${diagramId}/submissions`)).statusCode).toBe(200); // push 2 to PR 1
      fake.mergePull(repo, 1);
      await refresh(diagramId);
      await save(diagramId, `${DSL_V2}  C --> D[Archive]:::step\n`);
      const third = await call('POST', `/diagrams/${diagramId}/submissions`);
      expect(third.statusCode, third.body).toBe(201); // PR 2

      const res = await call('GET', `/diagrams/${diagramId}/submissions`, 'viewer');
      expect(res.statusCode).toBe(403); // not shared
      const history = (await call('GET', `/diagrams/${diagramId}/submissions`)).json().submissions;
      expect(history.map((s: { prNumber: number; state: string }) => [s.prNumber, s.state])).toEqual([[2, 'open'], [1, 'merged']]);
      expect(history[1].pushes).toHaveLength(2);
      expect(history[1].pushes.map((p: { versionSequence: number }) => p.versionSequence)).toEqual([...history[1].pushes.map((p: { versionSequence: number }) => p.versionSequence)].sort((x, y) => y - x));
      expect(history[1].pushes[0]).toMatchObject({ pushedBy: 'Olivia <Owner>', warningCount: 0 });
      expect(history[1].pushes[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(history[1].pushes[0].versionSequence).toBeGreaterThan(history[1].pushes[1].versionSequence);
      expect(history[0].pushes).toHaveLength(1);
      expect(history[0].pushes[0].versionSequence).toBeGreaterThan(history[1].pushes[0].versionSequence);
    });

    it('a diagram never submitted has an empty history; a view-shared user can read it', async () => {
      const diagramId = await createDiagram();
      await call('POST', `/diagrams/${diagramId}/shares`, 'owner', { granteeUserId: ids.viewer, accessLevel: 'view' });
      const res = await call('GET', `/diagrams/${diagramId}/submissions`, 'viewer');
      expect(res.statusCode).toBe(200);
      expect(res.json().submissions).toEqual([]);
    });
  });

  describe('project badges', () => {
    const badges = async (project = projectId, who: Who = 'owner') => call('GET', `/projects/${project}/submission-statuses`, who);

    it('is the latest submission per diagram; an open one wins; changesSinceSubmitting flips after a save', async () => {
      const a = await submitted('Alpha');
      const b = await submitted('Beta');
      const never = await createDiagram('Never');
      fake.mergePull(repo, b.number);
      await refresh(b.diagramId);

      let statuses = (await badges()).json().statuses;
      expect(Object.keys(statuses).sort()).toEqual([a.diagramId, b.diagramId].sort());
      expect(statuses[never]).toBeUndefined();
      expect(statuses[a.diagramId]).toMatchObject({ state: 'open', prNumber: a.number, changesSinceSubmitting: false, withdrawn: false, submittedVersionSequence: 1 });
      expect(statuses[b.diagramId]).toMatchObject({ state: 'merged', changesSinceSubmitting: false });

      await save(a.diagramId, DSL_V2);
      statuses = (await badges()).json().statuses;
      expect(statuses[a.diagramId].changesSinceSubmitting).toBe(true);

      // Merged PR, then a new open one for Beta: the open one is shown.
      await save(b.diagramId, DSL_V2);
      expect((await call('POST', `/diagrams/${b.diagramId}/submissions`)).statusCode).toBe(201);
      statuses = (await badges()).json().statuses;
      expect(statuses[b.diagramId]).toMatchObject({ state: 'open', prNumber: 3 });
    });

    it('without an open one, the most recent wins and a withdrawn PR is flagged', async () => {
      const a = await submitted('Alpha');
      fake.closePull(repo, a.number);
      await refresh(a.diagramId);
      await save(a.diagramId, DSL_V2);
      expect((await call('POST', `/diagrams/${a.diagramId}/submissions`)).statusCode).toBe(201);
      expect((await call('POST', `/diagrams/${a.diagramId}/submission/withdraw`)).statusCode).toBe(200);
      const statuses = (await badges()).json().statuses;
      expect(statuses[a.diagramId]).toMatchObject({ state: 'closed', prNumber: 2, withdrawn: true });
    });

    it('excludes deleted diagrams and other projects\' diagrams', async () => {
      const kept = await submitted('Kept');
      const deleted = await submitted('Deleted');
      const otherProject = (await seedProject('Other', ids.owner)).id;
      await linkProject('other', otherRepo, otherProject);
      const elsewhere = await createDiagram('Elsewhere', otherProject);
      expect((await call('POST', `/diagrams/${elsewhere}/submissions`)).statusCode).toBe(201);
      expect((await call('DELETE', `/diagrams/${deleted.diagramId}`)).statusCode).toBe(204);

      const statuses = (await badges()).json().statuses;
      expect(Object.keys(statuses)).toEqual([kept.diagramId]);
      expect(Object.keys((await badges(otherProject)).json().statuses)).toEqual([elsewhere]);
    });

    it('403 without access to the project, 404 for a missing one, 401 without a cookie', async () => {
      await submitted();
      expect((await badges(projectId, 'stranger')).statusCode).toBe(403);
      expect((await badges('00000000-0000-4000-8000-000000000000', 'admin')).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/projects/${projectId}/submission-statuses` })).statusCode).toBe(401);
    });
  });

  describe('admin links list', () => {
    it('shows how many pull requests are still open for each link', async () => {
      const links = async () => (await call('GET', '/admin/github/links', 'admin')).json().links as { projectId: string; openSubmissionCount: number }[];
      expect((await links())[0].openSubmissionCount).toBe(0);
      const a = await submitted('Alpha');
      await submitted('Beta');
      expect((await links())[0].openSubmissionCount).toBe(2);
      fake.mergePull(repo, a.number);
      await refresh(a.diagramId);
      expect((await links())[0].openSubmissionCount).toBe(1);

      // Removing the link leaves the pull requests open, and the job keeps syncing them.
      expect((await call('DELETE', `/projects/${projectId}/github-link`, 'admin')).statusCode).toBe(204);
      expect(await links()).toEqual([]);
      const counts = await syncOpenSubmissions(client, 0);
      expect(counts.open).toBe(1);
    });

    it('two links count only their own pull requests', async () => {
      const otherProject = (await seedProject('Other', ids.owner)).id;
      await linkProject('other', otherRepo, otherProject);
      await submitted('Alpha');
      const elsewhere = await createDiagram('Elsewhere', otherProject);
      await call('POST', `/diagrams/${elsewhere}/submissions`);
      await call('POST', `/diagrams/${elsewhere}/submission/withdraw`);
      const links = (await call('GET', '/admin/github/links', 'admin')).json().links as { projectId: string; openSubmissionCount: number }[];
      expect(Object.fromEntries(links.map((l) => [l.projectId, l.openSubmissionCount]))).toEqual({ [projectId]: 1, [otherProject]: 0 });
    });
  });
});
