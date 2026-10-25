import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetValidatorBundleCache } from '../../src/github/validator-bundle.js';
import { buildGitHubTestApp, startFakeGitHub, type FakeGitHub, type FakeRepo } from '../helpers/fake-github.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-3s5.3: the CI validator Canvas commits with every submission (.canvas/validator.mjs), the
 * example workflow endpoint, and a real end-to-end proof: the bundle a submission commits validates
 * what the same submission committed.
 */
const VALIDATOR_PKG = fileURLToPath(new URL('../../../../packages/validator-cli/', import.meta.url));
const FRONT_MATTER = '---\ncanvas:\n  positions:\n    A:\n      x: 40\n      y: 40\n    B:\n      x: 240\n      y: 40\n---\n';
const DSL = `${FRONT_MATTER}flowchart TD\n  A[Receive order]:::step --> B[Ship order]:::step\n`;
const STANDARD = {
  name: 'Order process rules',
  description: 'Steps for order flows.',
  requireKnownKinds: true,
  elementKinds: [{ id: 'step', label: 'Step', shapes: ['rectangle'], approvedFills: [], minCount: 2 }],
  severityOverrides: { 'kind-min-count': 'error' },
};
const VALIDATOR_PATH = '.canvas/validator.mjs';

describe('the CI validator in submissions (canvas-3s5.3)', () => {
  let fake: FakeGitHub;
  let app: FastifyInstance;
  let repo: FakeRepo;
  let projectId = '';
  let validatorDir = '';
  const cookies = {} as Record<'admin' | 'owner', string>;
  const scratch: string[] = [];
  const savedEnv = process.env.CANVAS_VALIDATOR_DIR;

  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  };
  async function login(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'PUT' | 'POST' | 'PATCH', url: string, who: 'admin' | 'owner' = 'owner', payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: cookies[who] }, payload: payload as object });
  const useValidator = (content: string | null, workflow: string | null = null) => {
    validatorDir = tempDir('canvas-validator-dir-');
    if (content !== null) writeFileSync(join(validatorDir, 'validator.mjs'), content);
    if (workflow !== null) writeFileSync(join(validatorDir, 'canvas-diagrams.yml'), workflow);
    process.env.CANVAS_VALIDATOR_DIR = validatorDir;
    resetValidatorBundleCache();
  };
  async function createDiagram(dsl = DSL): Promise<string> {
    const res = await call('POST', `/projects/${projectId}/diagrams`, 'owner', { name: 'Order Flow', diagramTypeId: 'flowchart', initialDslContent: dsl });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().diagram.id as string;
  }
  async function publishStandard() {
    const created = await call('POST', '/diagram-types/flowchart/standards', 'admin', STANDARD);
    expect(created.statusCode, created.body).toBe(201);
    expect((await call('POST', `/standards/${created.json().standard.id}/publish`, 'admin')).statusCode).toBe(200);
  }
  const submit = (diagramId: string) => call('POST', `/diagrams/${diagramId}/submissions`);
  const branchFiles = (branch: string) => fake.files(repo, branch)!;

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
    delete process.env.CANVAS_VALIDATOR_DIR;
    resetValidatorBundleCache();
    await resetDatabase();
    await seedFlowchartDiagramType();
    fake.clearRecords();
    fake.installations.clear();
    fake.repos.clear();
    const installation = fake.addInstallation({ account: 'acme' });
    repo = fake.addRepo(installation.id, { name: 'architecture' });
    const admin = await seedUser({ email: 'admin@example.com', name: 'Adam Admin', password: 'admin-pass', role: 'admin' }); // gitleaks:allow
    const owner = await seedUser({ email: 'owner@example.com', name: 'Olivia Owner', password: 'owner-pass', role: 'architect' }); // gitleaks:allow
    cookies.admin = await login('admin@example.com', 'admin-pass'); // gitleaks:allow
    cookies.owner = await login('owner@example.com', 'owner-pass'); // gitleaks:allow
    projectId = (await seedProject('Orders', owner.id)).id;
    expect(admin.id).toBeTruthy();
    expect((await call('PUT', `/projects/${projectId}/github-link`, 'admin', { repoId: repo.id, folder: 'architecture' })).statusCode).toBe(200);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CANVAS_VALIDATOR_DIR;
    else process.env.CANVAS_VALIDATOR_DIR = savedEnv;
    resetValidatorBundleCache();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('.canvas/validator.mjs in the pull request', () => {
    it('is committed with the content of the configured validator', async () => {
      useValidator('// validator v1\n');
      const res = await submit(await createDiagram());
      expect(res.statusCode, res.body).toBe(201);
      expect(branchFiles(res.json().submission.branch).get(VALIDATOR_PATH)).toBe('// validator v1\n');
    });

    it('is left out when no validator is available', async () => {
      useValidator(null);
      const res = await submit(await createDiagram());
      expect(res.statusCode, res.body).toBe(201);
      expect(branchFiles(res.json().submission.branch).has(VALIDATOR_PATH)).toBe(false);
    });

    it('is left out in tests when CANVAS_VALIDATOR_DIR is not set, whatever is built locally', async () => {
      const res = await submit(await createDiagram());
      expect(res.statusCode, res.body).toBe(201);
      expect(branchFiles(res.json().submission.branch).has(VALIDATOR_PATH)).toBe(false);
    });

    it('resubmitting unchanged is upToDate: no new commit even though the validator is included', async () => {
      useValidator('// validator v1\n');
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      const head = fake.headOf(repo, first.branch);
      fake.clearRecords();

      const again = await submit(diagramId);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().outcome).toBe('upToDate');
      expect(fake.headOf(repo, first.branch)).toBe(head);
      expect(fake.callsTo('POST', /git\/commits$/)).toEqual([]);
    });

    it('a changed validator is committed by the next submission, and only that file changes', async () => {
      useValidator('// validator v1\n');
      const diagramId = await createDiagram();
      const first = (await submit(diagramId)).json().submission;
      const before = new Map(branchFiles(first.branch));
      const head = fake.headOf(repo, first.branch);

      useValidator('// validator v2\n');
      const again = await submit(diagramId);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().outcome).toBe('updated');
      expect(fake.headOf(repo, first.branch)).not.toBe(head);

      const after = branchFiles(first.branch);
      const changed = [...after.keys()].filter((path) => before.get(path) !== after.get(path));
      expect(changed).toEqual([VALIDATOR_PATH]);
      expect(after.get(VALIDATOR_PATH)).toBe('// validator v2\n');
    });
  });

  describe('GET /admin/github/workflow-example and status', () => {
    it('an admin gets the workflow as a text/yaml attachment', async () => {
      useValidator('// v\n', 'name: Canvas diagrams\n');
      const res = await call('GET', '/admin/github/workflow-example', 'admin');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toContain('text/yaml');
      expect(res.headers['content-disposition']).toBe('attachment; filename="canvas-diagrams.yml"');
      expect(res.body).toBe('name: Canvas diagrams\n');
    });

    it('a non-admin gets 403 and an anonymous request 401', async () => {
      useValidator('// v\n', 'name: x\n');
      expect((await call('GET', '/admin/github/workflow-example', 'owner')).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/admin/github/workflow-example' })).statusCode).toBe(401);
    });

    it('is 404 when the workflow is not available', async () => {
      useValidator('// v\n', null);
      expect((await call('GET', '/admin/github/workflow-example', 'admin')).statusCode).toBe(404);
    });

    it('status reports validatorAvailable', async () => {
      expect((await call('GET', '/admin/github/status', 'admin')).json().validatorAvailable).toBe(false);
      useValidator('// v\n');
      expect((await call('GET', '/admin/github/status', 'admin')).json().validatorAvailable).toBe(true);
      useValidator(null);
      expect((await call('GET', '/admin/github/status', 'admin')).json().validatorAvailable).toBe(false);
    });
  });

  describe('the committed validator checks what the same submission committed', () => {
    function checkout(branch: string): string {
      const dir = tempDir('canvas-checkout-');
      for (const [path, content] of branchFiles(branch)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
      return dir;
    }
    const runValidator = (cwd: string) =>
      new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile(process.execPath, [VALIDATOR_PATH, '--format', 'github'], { cwd, env: { PATH: process.env.PATH } }, (error, stdout) =>
          resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout }),
        );
      });

    beforeAll(() => {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: VALIDATOR_PKG, stdio: 'pipe' });
    });
    beforeEach(() => {
      process.env.CANVAS_VALIDATOR_DIR = join(VALIDATOR_PKG, 'dist');
      resetValidatorBundleCache();
    });

    it('passes on the untouched checkout, and fails with an annotation once the source is tampered with', async () => {
      await publishStandard();
      const res = await submit(await createDiagram());
      expect(res.statusCode, res.body).toBe(201);
      const branch = res.json().submission.branch as string;
      const sourcePath = 'architecture/order-flow/order-flow.canvas.mmd';
      expect(branchFiles(branch).has(VALIDATOR_PATH)).toBe(true);

      const clean = checkout(branch);
      const ok = await runValidator(clean);
      expect(ok.stdout).toContain('1 diagram checked: 0 errors, 0 warnings.');
      expect(ok.code).toBe(0);

      // Break the standard: a node of a kind the standard doesn't define (and a hash mismatch warning).
      const broken = checkout(branch);
      writeFileSync(join(broken, sourcePath), DSL.replace('B[Ship order]:::step', 'B[Ship order]:::mystery'));
      const kind = await runValidator(broken);
      expect(kind.code).toBe(1);
      expect(kind.stdout).toMatch(new RegExp(`^::error file=${sourcePath.replace(/[./]/g, '\\$&')},line=\\d+,title=Must fix`, 'm'));
      expect(kind.stdout).toContain('::warning file=' + sourcePath);

      // Break the syntax.
      const syntax = checkout(branch);
      writeFileSync(join(syntax, sourcePath), 'flowchart TD\n  A[Receive order]:::step --> B[Ship\n');
      const bad = await runValidator(syntax);
      expect(bad.code).toBe(1);
      expect(bad.stdout).toMatch(new RegExp(`^::error file=${sourcePath.replace(/[./]/g, '\\$&')}(,line=\\d+)?,title=Syntax error`, 'm'));
    });
  });
});
