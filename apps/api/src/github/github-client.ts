import { createSign } from 'node:crypto';
import type { GitHubAppConfig } from '../config.js';

/**
 * canvas-3s5.1: a small GitHub REST client for the GitHub App Canvas submits diagrams with -- plain
 * `fetch`, no SDK. Authenticates as the App (a short-lived RS256 JWT) to find its installations,
 * and as an installation (a one-hour token, cached, narrowed to one repository) for everything
 * else. Tokens are never logged or included in an error message.
 */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}
/** GitHub's rate limit was hit; try again later. */
export class GitHubRateLimitError extends GitHubApiError {}
/** The App can't reach the repository any more (uninstalled, repo removed from the installation, ...). */
export class GitHubAccessError extends GitHubApiError {}
/** GitHub didn't answer (network, timeout). */
export class GitHubUnavailableError extends Error {}

const TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export interface InstallationSummary {
  id: number;
  account: string;
  repositorySelection: string;
  permissions: Record<string, string>;
}
export interface RepositorySummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}
export interface PullRequestSummary {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  mergedAt: string | null;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  closedAt: string | null;
  /** Logins (and team slugs) still asked to review. */
  requestedReviewers: string[];
}
/** An open pull request as listed by GitHub (canvas-3s5.5: finding one Canvas opened but didn't record). */
export interface OpenPullRequest {
  number: number;
  url: string;
  headRef: string;
  headSha: string;
  /** owner/name of the repository the head branch is in (differs for a fork). */
  headRepo: string | null;
  body: string;
  author: string;
}
export interface ReviewSummary {
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: string | null;
}
export interface CheckSummary {
  name: string;
  /** success | failure | pending | neutral | skipped */
  state: string;
  url: string | null;
}
export interface TreeEntry {
  path: string;
  content: string;
}
export type TokenPermissions = Record<string, 'read' | 'write'>;

/** Permissions a submission asks for -- no more than it uses. */
export const SUBMIT_PERMISSIONS: TokenPermissions = { contents: 'write', pull_requests: 'write', metadata: 'read' };

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
}
const toRepo = (r: RawRepo): RepositorySummary => ({
  id: r.id,
  owner: r.owner.login,
  name: r.name,
  fullName: r.full_name,
  defaultBranch: r.default_branch,
  private: r.private,
});

interface RawPull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at: string | null;
  merged_by?: { login: string } | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  head: { sha: string };
  requested_reviewers?: { login: string }[];
  requested_teams?: { slug: string }[];
}
const toPull = (p: RawPull): PullRequestSummary => ({
  number: p.number,
  url: p.html_url,
  state: p.state,
  merged: Boolean(p.merged ?? p.merged_at),
  headSha: p.head.sha,
  mergedAt: p.merged_at,
  mergedBy: p.merged_by?.login ?? null,
  mergeCommitSha: p.merge_commit_sha,
  closedAt: p.closed_at,
  requestedReviewers: [...(p.requested_reviewers ?? []).map((r) => r.login), ...(p.requested_teams ?? []).map((t) => `team:${t.slug}`)],
});

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
function checkRunState(run: { status: string; conclusion: string | null }): string {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) return 'failure';
  if (run.conclusion === 'success') return 'success';
  return run.conclusion ?? 'neutral';
}

export class GitHubClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get appId(): string {
    return this.config.appId;
  }

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  /** The App's own JWT: valid ten minutes at most (GitHub's limit), backdated for clock skew. */
  appJwt(): string {
    const issuedAt = Math.floor(this.now() / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: this.config.appId }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${base64url(signer.sign(this.config.privateKey))}`;
  }

  private async request<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const attempts = method === 'GET' ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: auth,
            'x-github-api-version': '2022-11-28',
            'user-agent': 'canvas-diagrams',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        lastError = new GitHubUnavailableError(`GitHub could not be reached (${error instanceof Error ? error.name : 'error'}).`);
        continue;
      }
      if (response.status >= 500 && attempt < attempts) {
        lastError = new GitHubApiError(response.status, `GitHub returned ${response.status}.`, path);
        continue;
      }
      if (response.status === 204) return undefined as T;
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new GitHubUnavailableError('GitHub did not finish answering.');
      }
      // An error from a proxy in front of GitHub can be HTML, not JSON: that is a GitHub failure
      // (502), never an unhandled SyntaxError (500).
      let json: unknown;
      let parsed = true;
      try {
        json = text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        parsed = false;
      }
      if (response.ok) {
        if (!parsed) throw new GitHubApiError(response.status, 'GitHub returned an unreadable response.', path);
        return json as T;
      }
      const message = (json as { message?: string } | undefined)?.message ?? `GitHub returned ${response.status}.`;
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
        throw new GitHubRateLimitError(response.status, 'GitHub rate limit reached; try again in a few minutes.', path);
      }
      throw new GitHubApiError(response.status, message, path);
    }
    throw lastError;
  }

  private asApp<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, `Bearer ${this.appJwt()}`, body);
  }

  /** Drops cached installation tokens, so the next call picks up permission changes at once
   *  (a token keeps the permissions it was issued with for its whole hour). */
  forgetTokens(): void {
    this.tokens.clear();
  }

  /** A token for one installation, optionally narrowed to some repositories and permissions. */
  async installationToken(installationId: number, repositoryIds?: number[], permissions?: TokenPermissions): Promise<string> {
    const key = JSON.stringify([installationId, repositoryIds ?? null, permissions ?? null]);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) return cached.token;
    let result: { token: string; expires_at: string };
    try {
      result = await this.asApp('POST', `/app/installations/${installationId}/access_tokens`, {
        ...(repositoryIds ? { repository_ids: repositoryIds } : {}),
        ...(permissions ? { permissions } : {}),
      });
    } catch (error) {
      if (error instanceof GitHubApiError && !(error instanceof GitHubRateLimitError) && [401, 403, 404, 422].includes(error.status)) {
        throw new GitHubAccessError(error.status, 'The Canvas GitHub App no longer has access to this repository (check the installation).', error.path);
      }
      throw error;
    }
    this.tokens.set(key, { token: result.token, expiresAt: Date.parse(result.expires_at) });
    return result.token;
  }

  private async asInstallation<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.request<T>(method, path, `token ${token}`, body);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 401) {
        this.tokens.clear();
        throw new GitHubAccessError(401, 'GitHub rejected the Canvas App token.', error.path);
      }
      throw error;
    }
  }

  async listInstallations(): Promise<InstallationSummary[]> {
    const raw = await this.asApp<{ id: number; account: { login: string } | null; repository_selection: string; permissions: Record<string, string> }[]>(
      'GET',
      '/app/installations?per_page=100',
    );
    return raw.map((i) => ({ id: i.id, account: i.account?.login ?? '', repositorySelection: i.repository_selection, permissions: i.permissions ?? {} }));
  }

  async getInstallation(installationId: number): Promise<InstallationSummary> {
    const i = await this.asApp<{ id: number; account: { login: string } | null; repository_selection: string; permissions: Record<string, string> }>(
      'GET',
      `/app/installations/${installationId}`,
    );
    return { id: i.id, account: i.account?.login ?? '', repositorySelection: i.repository_selection, permissions: i.permissions ?? {} };
  }

  /** Every repository an installation can reach (up to 1,000). */
  async listInstallationRepositories(installationId: number): Promise<RepositorySummary[]> {
    const token = await this.installationToken(installationId);
    const repos: RepositorySummary[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.asInstallation<{ total_count: number; repositories: RawRepo[] }>(token, 'GET', `/installation/repositories?per_page=100&page=${page}`);
      repos.push(...result.repositories.map(toRepo));
      if (result.repositories.length < 100 || repos.length >= result.total_count) break;
    }
    return repos;
  }

  /** By id, so a renamed or transferred repository is still found. */
  async getRepository(token: string, repoId: number): Promise<RepositorySummary> {
    return toRepo(await this.asInstallation<RawRepo>(token, 'GET', `/repositories/${repoId}`));
  }

  private repoPath(repo: { owner: string; name: string }): string {
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  }

  /** The commit a branch points at, or null if there's no such branch. */
  async getBranchSha(token: string, repo: { owner: string; name: string }, branch: string): Promise<string | null> {
    try {
      const ref = await this.asInstallation<{ object: { sha: string } }>(token, 'GET', `${this.repoPath(repo)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      return ref.object.sha;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getCommitTreeSha(token: string, repo: { owner: string; name: string }, commitSha: string): Promise<string> {
    const commit = await this.asInstallation<{ tree: { sha: string } }>(token, 'GET', `${this.repoPath(repo)}/git/commits/${commitSha}`);
    return commit.tree.sha;
  }

  /** A tree that is `baseTree` with these files written (text content; GitHub creates the blobs). */
  async createTree(token: string, repo: { owner: string; name: string }, baseTree: string, files: TreeEntry[]): Promise<string> {
    const tree = await this.asInstallation<{ sha: string }>(token, 'POST', `${this.repoPath(repo)}/git/trees`, {
      base_tree: baseTree,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    });
    return tree.sha;
  }

  async createCommit(token: string, repo: { owner: string; name: string }, message: string, tree: string, parent: string): Promise<string> {
    const commit = await this.asInstallation<{ sha: string }>(token, 'POST', `${this.repoPath(repo)}/git/commits`, { message, tree, parents: [parent] });
    return commit.sha;
  }

  /** Creates a branch; false if it already exists. */
  async createBranch(token: string, repo: { owner: string; name: string }, branch: string, sha: string): Promise<boolean> {
    try {
      await this.asInstallation(token, 'POST', `${this.repoPath(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      return true;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) return false;
      throw error;
    }
  }

  /** Moves a branch forward to `sha`. Never forced: fails (422) if `sha` doesn't follow from it. */
  async fastForwardBranch(token: string, repo: { owner: string; name: string }, branch: string, sha: string): Promise<void> {
    await this.asInstallation(token, 'PATCH', `${this.repoPath(repo)}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { sha, force: false });
  }

  async createPullRequest(token: string, repo: { owner: string; name: string }, pr: { title: string; head: string; base: string; body: string }): Promise<PullRequestSummary> {
    return toPull(await this.asInstallation<RawPull>(token, 'POST', `${this.repoPath(repo)}/pulls`, { ...pr, maintainer_can_modify: false }));
  }

  async updatePullRequest(token: string, repo: { owner: string; name: string }, number: number, patch: { title?: string; body?: string; state?: 'closed' }): Promise<PullRequestSummary> {
    return toPull(await this.asInstallation<RawPull>(token, 'PATCH', `${this.repoPath(repo)}/pulls/${number}`, patch));
  }

  async getPullRequest(token: string, repo: { owner: string; name: string }, number: number): Promise<PullRequestSummary> {
    return toPull(await this.asInstallation<RawPull>(token, 'GET', `${this.repoPath(repo)}/pulls/${number}`));
  }

  /** Every review on a pull request, oldest first. */
  async listReviews(token: string, repo: { owner: string; name: string }, number: number): Promise<ReviewSummary[]> {
    const reviews: ReviewSummary[] = [];
    for (let page = 1; page <= 5; page++) {
      const raw = await this.asInstallation<{ user: { login: string } | null; state: ReviewSummary['state']; submitted_at?: string | null }[]>(
        token,
        'GET',
        `${this.repoPath(repo)}/pulls/${number}/reviews?per_page=100&page=${page}`,
      );
      reviews.push(...raw.map((r) => ({ login: r.user?.login ?? 'ghost', state: r.state, submittedAt: r.submitted_at ?? null })));
      if (raw.length < 100) break;
    }
    return reviews;
  }

  /** Check runs (GitHub Actions, apps) and commit statuses (older CI integrations) on a commit. */
  async listChecks(token: string, repo: { owner: string; name: string }, sha: string): Promise<CheckSummary[]> {
    const runs = await this.asInstallation<{ check_runs: { name: string; status: string; conclusion: string | null; html_url: string | null }[] }>(
      token,
      'GET',
      `${this.repoPath(repo)}/commits/${sha}/check-runs?per_page=100`,
    );
    const status = await this.asInstallation<{ statuses: { context: string; state: string; target_url: string | null }[] }>(
      token,
      'GET',
      `${this.repoPath(repo)}/commits/${sha}/status`,
    );
    return [
      ...runs.check_runs.map((r) => ({ name: r.name, state: checkRunState(r), url: r.html_url })),
      ...status.statuses.map((st) => ({ name: st.context, state: st.state === 'error' ? 'failure' : st.state, url: st.target_url })),
    ];
  }

  async addPullRequestComment(token: string, repo: { owner: string; name: string }, number: number, body: string): Promise<void> {
    await this.asInstallation(token, 'POST', `${this.repoPath(repo)}/issues/${number}/comments`, { body });
  }

  /** Open pull requests into `base` (up to 500, newest first). */
  async listOpenPullRequests(token: string, repo: { owner: string; name: string }, base: string): Promise<OpenPullRequest[]> {
    const pulls: OpenPullRequest[] = [];
    for (let page = 1; page <= 5; page++) {
      const raw = await this.asInstallation<
        { number: number; html_url: string; body: string | null; user: { login: string } | null; head: { ref: string; sha: string; repo: { full_name: string } | null } }[]
      >(token, 'GET', `${this.repoPath(repo)}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&page=${page}`);
      pulls.push(
        ...raw.map((p) => ({
          number: p.number,
          url: p.html_url,
          headRef: p.head.ref,
          headSha: p.head.sha,
          headRepo: p.head.repo?.full_name ?? null,
          body: p.body ?? '',
          author: p.user?.login ?? '',
        })),
      );
      if (raw.length < 100) break;
    }
    return pulls;
  }
}
