import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * canvas-3s5.1: an in-memory GitHub for tests, on a real node:http server (127.0.0.1, random port).
 *
 * It is strict where the real GitHub is: App JWTs are verified with the test public key (RS256,
 * issuer, expiry <= 10 minutes, not issued in the future); installation tokens are checked on
 * every other call, including that the repository is inside the token's repository_ids and that
 * the token's permissions allow the operation. Git is modelled just enough: repos -> branches ->
 * commits -> trees (a path -> content map). A tree's sha is a hash of its content map, so creating
 * a tree from base_tree + entries that change nothing returns the SAME sha (the "up to date" path).
 */
export interface FakeInstallation {
  id: number;
  account: string;
  permissions: Record<string, string>;
  repositorySelection: string;
  repoIds: Set<number>;
}

interface FakeCommit {
  sha: string;
  message: string;
  tree: string;
  parents: string[];
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  reviews: FakeReview[];
  requestedReviewers: string[];
  requestedTeams: string[];
  comments: string[];
  /** Who opened it (default: the App's bot account). */
  author?: string;
  /** owner/name of the head branch's repository (default: this repository; set for a fork). */
  headRepo?: string;
}

export interface FakeReview {
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
}

export interface FakeCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}

export interface FakeCommitStatus {
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
}

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: number;
  private: boolean;
  branches: Map<string, string>;
  commits: Map<string, FakeCommit>;
  trees: Map<string, Map<string, string>>;
  pulls: Map<number, FakePull>;
  nextPull: number;
  /** commit sha -> check runs / commit statuses reported on it */
  checkRuns: Map<string, FakeCheckRun[]>;
  statuses: Map<string, FakeCommitStatus[]>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  auth: 'app' | 'installation' | 'none';
  body: unknown;
}

export interface TokenRequest {
  installationId: number;
  body: { repository_ids?: number[]; permissions?: Record<string, string> };
}

interface IssuedToken {
  installationId: number;
  repoIds: Set<number> | null;
  permissions: Record<string, string>;
  expiresAt: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const treeSha = (files: Map<string, string>) => sha1(JSON.stringify([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

export class FakeGitHub {
  readonly appId = '12345';
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  private server!: Server;
  url = '';

  readonly installations = new Map<number, FakeInstallation>();
  readonly repos = new Map<number, FakeRepo>();
  readonly requests: RecordedRequest[] = [];
  readonly tokenRequests: TokenRequest[] = [];
  private readonly tokens = new Map<string, IssuedToken>();
  private nextRepoId = 1001;

  /** Called just before a branch is moved (PATCH git/refs), so a test can race it. */
  beforeRefUpdate?: (repo: FakeRepo, branch: string) => void;
  /** Delays every response by this many ms (to make concurrent requests overlap). */
  latencyMs = 0;
  /** When set, every request answers with this status (e.g. 500, 429). */
  failWith: { status: number; headers?: Record<string, string> } | null = null;
  /**
   * Answers requests under `/_fake/` (test control, not part of GitHub's API) before any auth or
   * recording. Only the standalone runner sets it; return a JSON-able value, or throw HttpError-like
   * `{ status, message }` via `controlError`.
   */
  control?: (method: string, url: URL, body: unknown) => unknown | Promise<unknown>;

  constructor() {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  /** Listens on a random port, or `port` when given (the standalone runner used by the e2e suite). */
  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- setup / test helpers ------------------------------------------------------------------

  addInstallation(options: { id?: number; account?: string; permissions?: Record<string, string> } = {}): FakeInstallation {
    const id = options.id ?? 7000 + this.installations.size + 1;
    const installation: FakeInstallation = {
      id,
      account: options.account ?? 'acme',
      permissions: options.permissions ?? { contents: 'write', pull_requests: 'write', metadata: 'read' },
      repositorySelection: 'selected',
      repoIds: new Set(),
    };
    this.installations.set(id, installation);
    return installation;
  }

  /** A repository on an installation, with a base branch holding one commit (a README by default). */
  addRepo(installationId: number, options: { owner?: string; name: string; defaultBranch?: string; files?: Record<string, string> }): FakeRepo {
    const installation = this.installations.get(installationId);
    if (!installation) throw new Error(`no installation ${installationId}`);
    const defaultBranch = options.defaultBranch ?? 'main';
    const repo: FakeRepo = {
      id: this.nextRepoId++,
      owner: options.owner ?? installation.account,
      name: options.name,
      defaultBranch,
      installationId,
      private: true,
      branches: new Map(),
      commits: new Map(),
      trees: new Map(),
      pulls: new Map(),
      nextPull: 1,
      checkRuns: new Map(),
      statuses: new Map(),
    };
    const files = new Map(Object.entries(options.files ?? { 'README.md': '# repo\n' }));
    const tree = treeSha(files);
    repo.trees.set(tree, files);
    const commit: FakeCommit = { sha: sha1(`root:${repo.id}:${tree}`), message: 'Initial commit', tree, parents: [] };
    repo.commits.set(commit.sha, commit);
    repo.branches.set(defaultBranch, commit.sha);
    this.repos.set(repo.id, repo);
    installation.repoIds.add(repo.id);
    return repo;
  }

  removeRepoFromInstallation(repo: FakeRepo): void {
    this.installations.get(repo.installationId)?.repoIds.delete(repo.id);
  }

  addRepoToInstallation(repo: FakeRepo): void {
    this.installations.get(repo.installationId)?.repoIds.add(repo.id);
  }

  removeInstallation(installationId: number): void {
    this.installations.delete(installationId);
  }

  renameRepo(repo: FakeRepo, name: string): void {
    repo.name = name;
  }

  /** The files on a branch (path -> content), or null if there is no such branch. */
  files(repo: FakeRepo, branch: string): Map<string, string> | null {
    const sha = repo.branches.get(branch);
    return sha ? (repo.trees.get(repo.commits.get(sha)!.tree) ?? null) : null;
  }

  /** Commits reachable from a branch's head, newest first (first-parent). */
  commitsOn(repo: FakeRepo, branch: string): FakeCommit[] {
    const out: FakeCommit[] = [];
    let sha: string | undefined = repo.branches.get(branch);
    while (sha) {
      const commit = repo.commits.get(sha)!;
      out.push(commit);
      sha = commit.parents[0];
    }
    return out;
  }

  headOf(repo: FakeRepo, branch: string): string {
    const sha = repo.branches.get(branch);
    if (!sha) throw new Error(`no branch ${branch}`);
    return sha;
  }

  /** Merges a pull request the way GitHub's fast-forward-able merge would: the base moves to the head. */
  mergePull(repo: FakeRepo, number: number, options: { by?: string; applyToBase?: boolean } = {}): void {
    const pull = this.pull(repo, number);
    const head = repo.branches.get(pull.head)!;
    if (options.applyToBase !== false) repo.branches.set(pull.base, head);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.closedAt = pull.mergedAt;
    pull.mergedBy = options.by ?? 'reviewer';
    pull.mergeCommitSha = head;
  }

  closePull(repo: FakeRepo, number: number): void {
    const pull = this.pull(repo, number);
    pull.state = 'closed';
    pull.closedAt = new Date().toISOString();
  }

  /** Points a branch at some other commit, even if that drops commits (a force-push). */
  forceMoveBranch(repo: FakeRepo, branch: string, sha: string): void {
    repo.branches.set(branch, sha);
  }

  /** A commit whose parent is `parentSha` and which writes `files`, without moving any branch. */
  makeCommit(repo: FakeRepo, parentSha: string, files: Record<string, string>, message = 'outside change'): string {
    const parent = repo.commits.get(parentSha)!;
    const merged = new Map(repo.trees.get(parent.tree)!);
    for (const [path, content] of Object.entries(files)) merged.set(path, content);
    const tree = treeSha(merged);
    repo.trees.set(tree, merged);
    const commit: FakeCommit = { sha: sha1(`${tree}|${parentSha}|${message}`), message, tree, parents: [parentSha] };
    repo.commits.set(commit.sha, commit);
    return commit.sha;
  }

  addReview(repo: FakeRepo, number: number, login: string, state: FakeReview['state']): void {
    this.pull(repo, number).reviews.push({ login, state });
  }

  requestReviewer(repo: FakeRepo, number: number, login: string): void {
    this.pull(repo, number).requestedReviewers.push(login);
  }

  requestTeam(repo: FakeRepo, number: number, slug: string): void {
    this.pull(repo, number).requestedTeams.push(slug);
  }

  setCheckRuns(repo: FakeRepo, sha: string, runs: FakeCheckRun[]): void {
    repo.checkRuns.set(sha, runs);
  }

  setStatuses(repo: FakeRepo, sha: string, statuses: FakeCommitStatus[]): void {
    repo.statuses.set(sha, statuses);
  }

  /** Lets the installation read checks and commit statuses (not granted by default). */
  grantChecks(installationId: number): void {
    const granted = { checks: 'read', statuses: 'read' };
    Object.assign(this.installations.get(installationId)!.permissions, granted);
    // Canvas caches installation tokens (and an unnarrowed one is minted when a project is linked),
    // so apply it to tokens already issued, as if the permission had been there when they were minted.
    for (const issued of this.tokens.values()) if (issued.installationId === installationId) Object.assign(issued.permissions, granted);
  }

  deleteBranch(repo: FakeRepo, branch: string): void {
    repo.branches.delete(branch);
  }

  pull(repo: FakeRepo, number: number): FakePull {
    const pull = repo.pulls.get(number);
    if (!pull) throw new Error(`no pull #${number}`);
    return pull;
  }

  openPulls(repo: FakeRepo): FakePull[] {
    return [...repo.pulls.values()].filter((p) => p.state === 'open');
  }

  callsTo(method: string, pathPattern: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && pathPattern.test(r.path));
  }

  clearRecords(): void {
    this.requests.length = 0;
    this.tokenRequests.length = 0;
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', this.url);
    const method = req.method ?? 'GET';
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    if (this.control && url.pathname.startsWith('/_fake/')) {
      try {
        const out = await this.control(method, url, body);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? {}));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    const record: RecordedRequest = { method, path: url.pathname, auth: 'none', body };
    this.requests.push(record);
    try {
      if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
      if (this.failWith) throw new HttpError(this.failWith.status, 'forced failure', this.failWith.headers);
      const result = await this.route(method, url, body, req.headers.authorization, record);
      if (result === undefined) {
        res.writeHead(204).end();
        return;
      }
      const status = method === 'POST' ? 201 : 200;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      if (error instanceof HttpError) {
        res.writeHead(error.status, { 'content-type': 'application/json', ...error.headers }).end(JSON.stringify({ message: error.message }));
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: `fake-github crashed: ${String(error)}` }));
    }
  }

  private async appAuth(header: string | undefined, record: RecordedRequest): Promise<void> {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new HttpError(401, 'A JSON web token could not be decoded');
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { algorithms: ['RS256'], issuer: this.appId });
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.iat !== 'number' || payload.iat > now) throw new Error("'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued");
      if (typeof payload.exp !== 'number' || payload.exp - payload.iat > 600) throw new Error("'Expiration time' claim ('exp') is too far in the future");
    } catch (error) {
      throw new HttpError(401, `Bad credentials: ${error instanceof Error ? error.message : 'invalid JWT'}`);
    }
    record.auth = 'app';
  }

  private installationAuth(header: string | undefined, record: RecordedRequest): IssuedToken {
    const value = header?.startsWith('token ') ? header.slice(6) : undefined;
    const issued = value ? this.tokens.get(value) : undefined;
    if (!issued || issued.expiresAt < Date.now() || !this.installations.has(issued.installationId)) throw new HttpError(401, 'Bad credentials');
    record.auth = 'installation';
    return issued;
  }

  private repoFor(token: IssuedToken, owner: string, name: string): FakeRepo {
    const repo = [...this.repos.values()].find((r) => r.owner === owner && r.name === name);
    return this.assertRepoAccess(token, repo);
  }

  private assertRepoAccess(token: IssuedToken, repo: FakeRepo | undefined): FakeRepo {
    const installation = this.installations.get(token.installationId);
    if (!repo || !installation?.repoIds.has(repo.id) || (token.repoIds && !token.repoIds.has(repo.id))) throw new HttpError(404, 'Not Found');
    return repo;
  }

  private need(token: IssuedToken, permission: string, level: 'read' | 'write'): void {
    const granted = token.permissions[permission];
    const ok = level === 'read' ? granted === 'read' || granted === 'write' : granted === 'write';
    if (!ok) throw new HttpError(403, 'Resource not accessible by integration');
  }

  private rawRepo(repo: FakeRepo) {
    return { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, default_branch: repo.defaultBranch, private: repo.private };
  }

  private rawPull(repo: FakeRepo, pull: FakePull) {
    return {
      number: pull.number,
      html_url: `https://github.test/${repo.owner}/${repo.name}/pull/${pull.number}`,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merged_by: pull.mergedBy ? { login: pull.mergedBy } : null,
      merge_commit_sha: pull.mergeCommitSha,
      closed_at: pull.closedAt,
      requested_reviewers: pull.requestedReviewers.map((login) => ({ login })),
      requested_teams: pull.requestedTeams.map((slug) => ({ slug })),
      user: { login: pull.author ?? 'canvas-test[bot]' },
      head: { sha: repo.branches.get(pull.head) ?? '', ref: pull.head, repo: { full_name: pull.headRepo ?? `${repo.owner}/${repo.name}` } },
      base: { ref: pull.base },
    };
  }

  private isAncestor(repo: FakeRepo, ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const sha = stack.pop()!;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      stack.push(...(repo.commits.get(sha)?.parents ?? []));
    }
    return false;
  }

  private async route(method: string, url: URL, body: unknown, authorization: string | undefined, record: RecordedRequest): Promise<unknown> {
    const path = url.pathname;
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpMatchArray | null;

    // ---- as the App
    if (method === 'GET' && path === '/app/installations') {
      await this.appAuth(authorization, record);
      return [...this.installations.values()].map((i) => this.rawInstallation(i));
    }
    if ((m = path.match(/^\/app\/installations\/(\d+)$/)) && method === 'GET') {
      await this.appAuth(authorization, record);
      const installation = this.installations.get(Number(m[1]));
      if (!installation) throw new HttpError(404, 'Not Found');
      return this.rawInstallation(installation);
    }
    if ((m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && method === 'POST') {
      await this.appAuth(authorization, record);
      const installation = this.installations.get(Number(m[1]));
      if (!installation) throw new HttpError(404, 'Not Found');
      const request = { installationId: installation.id, body: b as TokenRequest['body'] };
      this.tokenRequests.push(request);
      const ids = request.body.repository_ids;
      if (ids && ids.some((id) => !installation.repoIds.has(id))) throw new HttpError(422, 'There is at least one repository that does not exist or is not accessible to the parent installation.');
      const requested = request.body.permissions;
      if (requested) {
        for (const [name, level] of Object.entries(requested)) {
          const granted = installation.permissions[name];
          if (!granted || (level === 'write' && granted !== 'write')) throw new HttpError(422, `The permissions requested are not granted to this installation (${name}).`);
        }
      }
      const token = `ghs_${randomBytes(16).toString('hex')}`;
      const expiresAt = Date.now() + 60 * 60_000;
      this.tokens.set(token, { installationId: installation.id, repoIds: ids ? new Set(ids) : null, permissions: requested ?? { ...installation.permissions }, expiresAt });
      return { token, expires_at: new Date(expiresAt).toISOString() };
    }

    // ---- as an installation
    const token = this.installationAuth(authorization, record);

    if (method === 'GET' && path === '/installation/repositories') {
      const installation = this.installations.get(token.installationId)!;
      const repos = [...installation.repoIds].filter((id) => !token.repoIds || token.repoIds.has(id)).map((id) => this.rawRepo(this.repos.get(id)!));
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      return { total_count: repos.length, repositories: repos.slice((page - 1) * perPage, page * perPage) };
    }
    if ((m = path.match(/^\/repositories\/(\d+)$/)) && method === 'GET') {
      return this.rawRepo(this.assertRepoAccess(token, this.repos.get(Number(m[1]))));
    }

    if (!(m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/))) throw new HttpError(404, 'Not Found');
    const repo = this.repoFor(token, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    const rest = m[3];
    let r: RegExpMatchArray | null;

    if (method === 'GET' && (r = rest.match(/^git\/ref\/heads\/(.+)$/))) {
      this.need(token, 'contents', 'read');
      const branch = decodeURIComponent(r[1]);
      const sha = repo.branches.get(branch);
      if (!sha) throw new HttpError(404, 'Not Found');
      return { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } };
    }
    if (method === 'GET' && (r = rest.match(/^git\/commits\/([0-9a-f]+)$/))) {
      this.need(token, 'contents', 'read');
      const commit = repo.commits.get(r[1]);
      if (!commit) throw new HttpError(404, 'Not Found');
      return { sha: commit.sha, message: commit.message, tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) };
    }
    // canvas-finl: tree listing and blob reads. A blob's sha is the hash of its content.
    if (method === 'GET' && (r = rest.match(/^git\/trees\/([0-9a-f]+)$/))) {
      this.need(token, 'contents', 'read');
      const files = repo.trees.get(r[1]);
      if (!files) throw new HttpError(404, 'Not Found');
      return {
        sha: r[1],
        truncated: false,
        tree: [...files.entries()].map(([path, content]) => ({ path, mode: '100644', type: 'blob', sha: sha1(`blob|${content}`), size: Buffer.byteLength(content) })),
      };
    }
    if (method === 'GET' && (r = rest.match(/^git\/blobs\/([0-9a-f]+)$/))) {
      this.need(token, 'contents', 'read');
      for (const files of repo.trees.values()) {
        for (const content of files.values()) {
          if (sha1(`blob|${content}`) === r[1]) return { sha: r[1], encoding: 'base64', content: Buffer.from(content).toString('base64') };
        }
      }
      throw new HttpError(404, 'Not Found');
    }
    if (method === 'POST' && rest === 'git/trees') {
      this.need(token, 'contents', 'write');
      const base = repo.trees.get(String(b.base_tree));
      if (b.base_tree !== undefined && !base) throw new HttpError(422, 'base_tree does not exist');
      const files = new Map(base ?? []);
      for (const entry of (b.tree as { path: string; mode: string; type: string; content?: string }[]) ?? []) {
        if (typeof entry.content !== 'string' || entry.type !== 'blob') throw new HttpError(422, 'tree entries need type blob and string content');
        files.set(entry.path, entry.content);
      }
      const sha = treeSha(files);
      repo.trees.set(sha, files);
      return { sha };
    }
    if (method === 'POST' && rest === 'git/commits') {
      this.need(token, 'contents', 'write');
      const parents = (b.parents as string[]) ?? [];
      if (!repo.trees.has(String(b.tree)) || parents.some((p) => !repo.commits.has(p))) throw new HttpError(422, 'Tree or parent does not exist');
      const commit: FakeCommit = { sha: sha1(`${b.tree}|${parents.join(',')}|${b.message}`), message: String(b.message), tree: String(b.tree), parents };
      repo.commits.set(commit.sha, commit);
      return { sha: commit.sha };
    }
    if (method === 'POST' && rest === 'git/refs') {
      this.need(token, 'contents', 'write');
      const name = String(b.ref).replace(/^refs\/heads\//, '');
      if (repo.branches.has(name)) throw new HttpError(422, 'Reference already exists');
      if (!repo.commits.has(String(b.sha))) throw new HttpError(422, 'Object does not exist');
      repo.branches.set(name, String(b.sha));
      return { ref: `refs/heads/${name}`, object: { sha: b.sha } };
    }
    if (method === 'PATCH' && (r = rest.match(/^git\/refs\/heads\/(.+)$/))) {
      this.need(token, 'contents', 'write');
      const branch = decodeURIComponent(r[1]);
      this.beforeRefUpdate?.(repo, branch);
      const current = repo.branches.get(branch);
      if (!current) throw new HttpError(422, 'Reference does not exist');
      if (!repo.commits.has(String(b.sha))) throw new HttpError(422, 'Object does not exist');
      if (b.force !== true && !this.isAncestor(repo, current, String(b.sha))) throw new HttpError(422, 'Update is not a fast forward');
      repo.branches.set(branch, String(b.sha));
      return { ref: `refs/heads/${branch}`, object: { sha: b.sha } };
    }

    if (method === 'GET' && rest === 'pulls') {
      // canvas-3s5.5: listing open pull requests (state + base filters, newest first, paged).
      this.need(token, 'pull_requests', 'read');
      const state = url.searchParams.get('state') ?? 'open';
      const base = url.searchParams.get('base');
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const matching = [...repo.pulls.values()]
        .filter((p) => (state === 'all' || p.state === state) && (!base || p.base === base))
        .sort((a, b) => b.number - a.number);
      return matching.slice((page - 1) * perPage, page * perPage).map((p) => this.rawPull(repo, p));
    }
    if (method === 'POST' && rest === 'pulls') {
      this.need(token, 'pull_requests', 'write');
      const head = String(b.head);
      const base = String(b.base);
      if (!repo.branches.has(head) || !repo.branches.has(base)) throw new HttpError(422, 'Validation Failed: head or base branch does not exist');
      if ([...repo.pulls.values()].some((p) => p.state === 'open' && p.head === head && p.base === base)) throw new HttpError(422, 'A pull request already exists');
      const pull: FakePull = { number: repo.nextPull++, title: String(b.title), body: String(b.body ?? ''), head, base, state: 'open', merged: false, mergedAt: null, mergedBy: null, mergeCommitSha: null, closedAt: null, reviews: [], requestedReviewers: [], requestedTeams: [], comments: [] };
      repo.pulls.set(pull.number, pull);
      return this.rawPull(repo, pull);
    }
    if (method === 'GET' && (r = rest.match(/^pulls\/(\d+)\/reviews$/))) {
      this.need(token, 'pull_requests', 'read');
      const pull = repo.pulls.get(Number(r[1]));
      if (!pull) throw new HttpError(404, 'Not Found');
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      return pull.reviews.slice((page - 1) * perPage, page * perPage).map((rv) => ({ user: { login: rv.login }, state: rv.state, submitted_at: new Date().toISOString() }));
    }
    if (method === 'POST' && (r = rest.match(/^issues\/(\d+)\/comments$/))) {
      this.need(token, 'pull_requests', 'write');
      const pull = repo.pulls.get(Number(r[1]));
      if (!pull) throw new HttpError(404, 'Not Found');
      pull.comments.push(String(b.body));
      return { id: pull.comments.length, body: b.body };
    }
    if (method === 'GET' && (r = rest.match(/^commits\/([0-9a-f]+)\/check-runs$/))) {
      this.need(token, 'checks', 'read');
      const runs = repo.checkRuns.get(r[1]) ?? [];
      return { total_count: runs.length, check_runs: runs.map((run) => ({ ...run, html_url: `https://github.test/run/${run.name}` })) };
    }
    if (method === 'GET' && (r = rest.match(/^commits\/([0-9a-f]+)\/status$/))) {
      this.need(token, 'statuses', 'read');
      const statuses = repo.statuses.get(r[1]) ?? [];
      return { state: 'pending', statuses: statuses.map((st) => ({ ...st, target_url: `https://github.test/status/${st.context}` })) };
    }
    if ((r = rest.match(/^pulls\/(\d+)$/))) {
      const pull = repo.pulls.get(Number(r[1]));
      if (!pull) throw new HttpError(404, 'Not Found');
      if (method === 'GET') {
        this.need(token, 'pull_requests', 'read');
        return this.rawPull(repo, pull);
      }
      if (method === 'PATCH') {
        this.need(token, 'pull_requests', 'write');
        if (typeof b.title === 'string') pull.title = b.title;
        if (typeof b.body === 'string') pull.body = b.body;
        if (b.state === 'closed' && pull.state === 'open') this.closePull(repo, pull.number);
        return this.rawPull(repo, pull);
      }
    }
    throw new HttpError(404, `fake-github has no route for ${method} ${path}`);
  }

  private rawInstallation(i: FakeInstallation) {
    return { id: i.id, account: { login: i.account }, repository_selection: i.repositorySelection, permissions: i.permissions };
  }
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  return new FakeGitHub().start();
}

/** Config for an app wired to the fake (or with GitHub switched off when `fake` is null). */
export function githubTestConfig(fake: FakeGitHub | null): AppConfig {
  process.env.NODE_ENV = 'test';
  const config = { ...loadConfig(), allowLocalAuth: true, publicUrl: 'http://canvas.test' };
  return fake ? { ...config, github: { appId: fake.appId, privateKey: fake.privateKey, apiUrl: fake.url } } : { ...config, github: undefined };
}

export async function buildGitHubTestApp(fake: FakeGitHub | null): Promise<FastifyInstance> {
  const config = githubTestConfig(fake);
  await runMigrations();
  return buildApp({ config, logger: false });
}
