import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GitHubAccessError,
  GitHubApiError,
  GitHubClient,
  GitHubRateLimitError,
  GitHubUnavailableError,
} from '../../src/github/github-client.js';

/** canvas-3s5.1: the App JWT, the installation-token cache and error mapping, with `fetch` as the only fake. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { appId: '12345', privateKey, apiUrl: 'https://github.test' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
type Responder = (call: Call, n: number) => Response | Promise<Response> | Error;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function harness(responder: Responder, startMs = Date.UTC(2026, 9, 24, 12, 0, 0)) {
  const calls: Call[] = [];
  const clock = { now: startMs };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const result = await responder(call, calls.length);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { client: new GitHubClient(config, fetchImpl, () => clock.now), calls, clock };
}

function decode(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iat: number; exp: number; iss: string },
    verifies: createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, 'base64url')),
  };
}

describe('GitHubClient.appJwt', () => {
  it('is an RS256 JWT, signed with the App key, issuer = app id', () => {
    const { client } = harness(() => json(200, {}));
    const { header, payload, verifies } = decode(client.appJwt());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('12345');
    expect(verifies).toBe(true);
  });

  it('backdates iat for clock skew and expires within GitHub\'s ten-minute limit', () => {
    const { client, clock } = harness(() => json(200, {}));
    const { payload } = decode(client.appJwt());
    const nowSeconds = Math.floor(clock.now / 1000);
    expect(payload.iat).toBeLessThan(nowSeconds);
    expect(nowSeconds - payload.iat).toBeLessThanOrEqual(60);
    expect(payload.exp).toBeGreaterThan(nowSeconds);
    // GitHub measures the ten minutes from the moment it receives the token.
    expect(payload.exp - nowSeconds).toBeLessThanOrEqual(10 * 60);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);
  });

  it('is signed fresh from the clock each time and a token from another key does not verify', () => {
    const { client, clock } = harness(() => json(200, {}));
    const a = client.appJwt();
    clock.now += 5000;
    expect(client.appJwt()).not.toBe(a);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const [h, p, s] = a.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(other.publicKey, Buffer.from(s, 'base64url'))).toBe(false);
  });

  it('sends the App JWT (not an installation token) to /app/installations', async () => {
    const { client, calls } = harness(() => json(200, [{ id: 1, account: { login: 'acme' }, repository_selection: 'selected', permissions: { contents: 'write' } }]));
    expect(await client.listInstallations()).toEqual([{ id: 1, account: 'acme', repositorySelection: 'selected', permissions: { contents: 'write' } }]);
    expect(calls[0].headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls[0].url).toBe('https://github.test/app/installations?per_page=100');
    expect(calls[0].headers['x-github-api-version']).toBe('2022-11-28');
  });
});

describe('GitHubClient.installationToken', () => {
  const tokenResponder = (counter = { n: 0 }): Responder => (call) => {
    if (call.url.endsWith('/access_tokens')) {
      counter.n++;
      return json(201, { token: `ghs_token${counter.n}`, expires_at: new Date(Date.UTC(2026, 9, 24, 13, 0, 0)).toISOString() });
    }
    return json(200, {});
  };

  it('asks for the narrowed repositories and permissions it was given, and sends nothing extra when unnarrowed', async () => {
    const { client, calls } = harness(tokenResponder());
    await client.installationToken(9, [42], { contents: 'write', metadata: 'read' });
    await client.installationToken(9);
    expect(calls[0].url).toBe('https://github.test/app/installations/9/access_tokens');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ repository_ids: [42], permissions: { contents: 'write', metadata: 'read' } });
    expect(calls[1].body).toEqual({});
  });

  it('reuses a cached token until five minutes before it expires, then fetches a new one', async () => {
    const counter = { n: 0 };
    const { client, calls, clock } = harness(tokenResponder(counter));
    const first = await client.installationToken(9, [42]);
    clock.now += 30 * 60_000; // 12:30, token valid to 13:00
    expect(await client.installationToken(9, [42])).toBe(first);
    expect(counter.n).toBe(1);
    clock.now = Date.UTC(2026, 9, 24, 12, 54, 59);
    expect(await client.installationToken(9, [42])).toBe(first);
    clock.now = Date.UTC(2026, 9, 24, 12, 55, 1);
    const refreshed = await client.installationToken(9, [42]);
    expect(refreshed).not.toBe(first);
    expect(counter.n).toBe(2);
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(2);
  });

  it('caches per installation, repositories and permissions (a narrowed token is never reused for a broader ask)', async () => {
    const counter = { n: 0 };
    const { client } = harness(tokenResponder(counter));
    await client.installationToken(9, [42]);
    await client.installationToken(9, [43]);
    await client.installationToken(9);
    await client.installationToken(10, [42]);
    await client.installationToken(9, [42], { contents: 'read' });
    expect(counter.n).toBe(5);
    await client.installationToken(9, [42]);
    expect(counter.n).toBe(5);
  });

  it('a rejected installation is GitHubAccessError (not cached), a rate limit is not turned into one', async () => {
    let status = 404;
    const { client } = harness(() => json(status, { message: 'Not Found' }));
    await expect(client.installationToken(9, [42])).rejects.toBeInstanceOf(GitHubAccessError);
    status = 422;
    await expect(client.installationToken(9, [42])).rejects.toBeInstanceOf(GitHubAccessError);
    status = 429;
    const error = await client.installationToken(9, [42]).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect(error).not.toBeInstanceOf(GitHubAccessError);
  });

  it('a 401 on an installation call drops cached tokens, so the next call fetches a fresh one', async () => {
    const counter = { n: 0 };
    let reject = true;
    const { client } = harness((call, n) => {
      if (call.url.endsWith('/access_tokens')) return tokenResponder(counter)(call, n);
      if (reject) return json(401, { message: 'Bad credentials' });
      return json(200, { object: { sha: 'abc' } });
    });
    const token = await client.installationToken(9, [42]);
    await expect(client.getBranchSha(token, { owner: 'o', name: 'r' }, 'main')).rejects.toBeInstanceOf(GitHubAccessError);
    reject = false;
    await client.installationToken(9, [42]);
    expect(counter.n).toBe(2);
  });
});

describe('GitHubClient requests and errors', () => {
  const repo = { owner: 'o', name: 'r' };

  it('never includes the token or key in an error message', async () => {
    const { client } = harness(() => json(500, { message: 'boom' }));
    const error = await client.getBranchSha('ghs_secrettoken', repo, 'main').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/ghs_secrettoken|Bearer|BEGIN/);
  });

  it('getBranchSha: 404 means no branch (null); slashes in a branch name stay path separators', async () => {
    const { client, calls } = harness((call) => (call.url.includes('missing') ? json(404, { message: 'Not Found' }) : json(200, { object: { sha: 'abc123' } })));
    expect(await client.getBranchSha('t', repo, 'missing')).toBeNull();
    expect(await client.getBranchSha('t', repo, 'canvas/ab12 cd-x')).toBe('abc123');
    expect(calls[1].url).toBe('https://github.test/repos/o/r/git/ref/heads/canvas/ab12%20cd-x');
    expect(calls[1].headers.authorization).toBe('token t');
  });

  it('createBranch: true on success, false on 422 (exists), throws on anything else', async () => {
    let status = 201;
    const { client } = harness(() => json(status, {}));
    expect(await client.createBranch('t', repo, 'b', 'sha')).toBe(true);
    status = 422;
    expect(await client.createBranch('t', repo, 'b', 'sha')).toBe(false);
    status = 403;
    await expect(client.createBranch('t', repo, 'b', 'sha')).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('fastForwardBranch is never forced', async () => {
    const { client, calls } = harness(() => json(200, {}));
    await client.fastForwardBranch('t', repo, 'canvas/x-r1', 'sha1');
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { sha: 'sha1', force: false } });
    expect(calls[0].url).toBe('https://github.test/repos/o/r/git/refs/heads/canvas/x-r1');
  });

  it('createTree sends base_tree and inline content entries', async () => {
    const { client, calls } = harness(() => json(201, { sha: 'tree1' }));
    expect(await client.createTree('t', repo, 'base', [{ path: 'a/b.md', content: 'hi' }])).toBe('tree1');
    expect(calls[0].body).toEqual({ base_tree: 'base', tree: [{ path: 'a/b.md', mode: '100644', type: 'blob', content: 'hi' }] });
  });

  it('maps a pull request, deriving merged from merged_at when GitHub omits the flag', async () => {
    const raw = { number: 7, html_url: 'https://github.test/o/r/pull/7', state: 'closed', merged_at: '2026-10-24T00:00:00Z', merged_by: { login: 'rev' }, merge_commit_sha: 'mc', closed_at: '2026-10-24T00:00:00Z', head: { sha: 'h' } };
    const { client } = harness(() => json(200, raw));
    expect(await client.getPullRequest('t', repo, 7)).toEqual({
      number: 7,
      url: raw.html_url,
      state: 'closed',
      merged: true,
      headSha: 'h',
      mergedAt: raw.merged_at,
      mergedBy: 'rev',
      mergeCommitSha: 'mc',
      closedAt: raw.closed_at,
      requestedReviewers: [],
    });
  });

  it('retries a GET once on a 5xx or a network error, but never a POST', async () => {
    const get = harness((_c, n) => (n === 1 ? json(502, { message: 'bad gateway' }) : json(200, { object: { sha: 'ok' } })));
    expect(await get.client.getBranchSha('t', repo, 'main')).toBe('ok');
    expect(get.calls).toHaveLength(2);

    const net = harness((_c, n) => (n === 1 ? new TypeError('fetch failed') : json(200, { object: { sha: 'ok' } })));
    expect(await net.client.getBranchSha('t', repo, 'main')).toBe('ok');

    const post = harness(() => json(502, { message: 'bad gateway' }));
    await expect(post.client.createCommit('t', repo, 'm', 'tree', 'parent')).rejects.toBeInstanceOf(GitHubApiError);
    expect(post.calls).toHaveLength(1);

    const down = harness(() => new TypeError('fetch failed'));
    await expect(down.client.getBranchSha('t', repo, 'main')).rejects.toBeInstanceOf(GitHubUnavailableError);
    expect(down.calls).toHaveLength(2);
    const postDown = harness(() => new TypeError('fetch failed'));
    await expect(postDown.client.createCommit('t', repo, 'm', 'tree', 'parent')).rejects.toBeInstanceOf(GitHubUnavailableError);
    expect(postDown.calls).toHaveLength(1);
  });

  it('recognises a rate limit by 429, or by 403 with no requests remaining; a plain 403 is an ordinary API error', async () => {
    for (const response of [json(429, { message: 'slow down' }), json(403, { message: 'limit' }, { 'x-ratelimit-remaining': '0' })]) {
      const { client } = harness(() => response.clone());
      await expect(client.getPullRequest('t', repo, 1)).rejects.toBeInstanceOf(GitHubRateLimitError);
    }
    const { client } = harness(() => json(403, { message: 'Resource not accessible by integration' }, { 'x-ratelimit-remaining': '4000' }));
    const error = await client.getPullRequest('t', repo, 1).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).not.toBeInstanceOf(GitHubRateLimitError);
    expect(error.status).toBe(403);
    expect(error.message).toBe('Resource not accessible by integration');
  });

  it('a non-JSON body (an HTML error page from a proxy) is a GitHub error, not a crash', async () => {
    const html = () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
    const { client } = harness(html);
    await expect(client.createCommit('t', repo, 'm', 'tree', 'parent')).rejects.toBeInstanceOf(GitHubApiError);
    const ok = harness(() => new Response('<html>captive portal</html>', { status: 200 }));
    await expect(ok.client.getPullRequest('t', repo, 1)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('lists repositories across pages until the total is reached', async () => {
    const repoRaw = (id: number) => ({ id, name: `r${id}`, full_name: `o/r${id}`, owner: { login: 'o' }, default_branch: 'main', private: true });
    const { client, calls } = harness((call) => {
      if (call.url.endsWith('/access_tokens')) return json(201, { token: 't', expires_at: '2099-01-01T00:00:00Z' });
      const page = Number(new URL(call.url).searchParams.get('page'));
      const ids = page === 1 ? Array.from({ length: 100 }, (_, i) => i + 1) : [101, 102];
      return json(200, { total_count: 102, repositories: ids.map(repoRaw) });
    });
    const repos = await client.listInstallationRepositories(9);
    expect(repos).toHaveLength(102);
    expect(calls.filter((c) => c.url.includes('/installation/repositories'))).toHaveLength(2);
    expect(repos[0]).toEqual({ id: 1, owner: 'o', name: 'r1', fullName: 'o/r1', defaultBranch: 'main', private: true });
  });
});

describe('GitHubClient sync calls (canvas-3s5.2)', () => {
  const repo = { owner: 'acme', name: 'arch' };
  const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, html_url: `https://ci/${name}` });

  async function checksFor(runs: ReturnType<typeof run>[], statuses: { context: string; state: string; target_url: string | null }[] = []) {
    const { client, calls } = harness((call) => (call.url.includes('/check-runs') ? json(200, { check_runs: runs }) : json(200, { statuses })));
    return { checks: await client.listChecks('t', repo, 'abc123'), calls };
  }

  it('listChecks asks for check runs and the combined status of the commit, and merges them', async () => {
    const { checks, calls } = await checksFor([run('build', 'completed', 'success')], [{ context: 'legacy', state: 'success', target_url: null }]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://github.test/repos/acme/arch/commits/abc123/check-runs?per_page=100',
      'https://github.test/repos/acme/arch/commits/abc123/status',
    ]);
    expect(checks).toEqual([
      { name: 'build', state: 'success', url: 'https://ci/build' },
      { name: 'legacy', state: 'success', url: null },
    ]);
  });

  it('check run conclusions: failures, running, and the not-failures', async () => {
    const { checks } = await checksFor([
      run('a', 'completed', 'failure'),
      run('b', 'completed', 'timed_out'),
      run('c', 'completed', 'cancelled'),
      run('d', 'completed', 'action_required'),
      run('e', 'in_progress', null),
      run('f', 'queued', null),
      run('g', 'completed', 'skipped'),
      run('h', 'completed', 'neutral'),
      run('i', 'completed', 'success'),
    ]);
    expect(Object.fromEntries(checks.map((c) => [c.name, c.state]))).toEqual({
      a: 'failure', b: 'failure', c: 'failure', d: 'failure', e: 'pending', f: 'pending', g: 'skipped', h: 'neutral', i: 'success',
    });
  });

  it('a commit status in error is a failure; pending and failure keep their meaning', async () => {
    const { checks } = await checksFor([], [
      { context: 'x', state: 'error', target_url: 'https://ci/x' },
      { context: 'y', state: 'failure', target_url: null },
      { context: 'z', state: 'pending', target_url: null },
    ]);
    expect(checks.map((c) => [c.name, c.state])).toEqual([['x', 'failure'], ['y', 'failure'], ['z', 'pending']]);
  });

  it('listChecks surfaces a 403 as a GitHubApiError carrying the status (the sync treats it as "unavailable")', async () => {
    const { client } = harness(() => json(403, { message: 'Resource not accessible by integration' }));
    const error = await client.listChecks('t', repo, 'abc').catch((e) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error.status).toBe(403);
  });

  it('getPullRequest reads requested reviewers and teams', async () => {
    const raw = {
      number: 4, html_url: 'u', state: 'open', merged_at: null, merge_commit_sha: null, closed_at: null, head: { sha: 's' },
      requested_reviewers: [{ login: 'ann' }], requested_teams: [{ slug: 'arch' }],
    };
    const { client } = harness(() => json(200, raw));
    expect((await client.getPullRequest('t', repo, 4)).requestedReviewers).toEqual(['ann', 'team:arch']);
  });

  it('listReviews pages by 100, maps a deleted user to ghost, and stops on a short page', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ user: i === 0 ? null : { login: `u${i}` }, state: 'COMMENTED', submitted_at: '2026-01-01T00:00:00Z' }));
    const { client, calls } = harness((call) => json(200, new URL(call.url).searchParams.get('page') === '1' ? page(100) : page(3)));
    const reviews = await client.listReviews('t', repo, 7);
    expect(reviews).toHaveLength(103);
    expect(reviews[0].login).toBe('ghost');
    expect(calls.map((c) => c.url)).toEqual([
      'https://github.test/repos/acme/arch/pulls/7/reviews?per_page=100&page=1',
      'https://github.test/repos/acme/arch/pulls/7/reviews?per_page=100&page=2',
    ]);
  });

  it('addPullRequestComment posts to the issues endpoint; closing patches state closed', async () => {
    const { client, calls } = harness(() => json(200, { number: 7, html_url: 'u', state: 'closed', merged_at: null, merge_commit_sha: null, closed_at: 'x', head: { sha: 's' } }));
    await client.addPullRequestComment('t', repo, 7, 'hello');
    await client.updatePullRequest('t', repo, 7, { state: 'closed' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://github.test/repos/acme/arch/issues/7/comments', body: { body: 'hello' } });
    expect(calls[1]).toMatchObject({ method: 'PATCH', url: 'https://github.test/repos/acme/arch/pulls/7', body: { state: 'closed' } });
  });
});
