import { writeFileSync } from 'node:fs';
import { FakeGitHub, type FakeCheckRun, type FakeReview } from './fake-github.js';

/**
 * canvas-3s5.1/3s5.2: the in-memory fake GitHub as a standalone process, for the Playwright suite
 * (apps/web/tests/e2e/github-approval.spec.ts), which runs the real web app and real API against it.
 *
 *   npx tsx tests/helpers/fake-github-server.ts [keyFile]
 *
 * Env: FAKE_GITHUB_PORT (default 3999), FAKE_GITHUB_KEY_FILE (or the first argument; default
 * ./fake-github.key) -- where the App's private key is written, base64 of the PEM on one line, ready
 * to be the API's GITHUB_APP_PRIVATE_KEY. Start the API with GITHUB_APP_ID=12345,
 * GITHUB_APP_PRIVATE_KEY=$(cat <keyFile>), GITHUB_APP_API_URL=http://127.0.0.1:<port>.
 *
 * Seeds one installation (account canvas-e2e) with one repository, canvas-e2e/architecture (default
 * branch main). Test control, all under /_fake/ (never part of GitHub's API):
 *   GET  /_fake/pulls                  -> every pull request
 *   GET  /_fake/files?branch=<name>    -> { files: { path: content } } on that branch
 *   POST /_fake/pulls/:n/reviews       {login, state}
 *   POST /_fake/pulls/:n/check-runs    {name, status?, conclusion?}  (set on the PR's current head)
 *   POST /_fake/pulls/:n/merge         {by?}
 *   POST /_fake/pulls/:n/close
 */
const port = Number(process.env.FAKE_GITHUB_PORT ?? 3999);
const keyFile = process.argv[2] ?? process.env.FAKE_GITHUB_KEY_FILE ?? './fake-github.key';

const fake = new FakeGitHub();
const installation = fake.addInstallation({ account: 'canvas-e2e' });
fake.grantChecks(installation.id);
const repo = fake.addRepo(installation.id, { name: 'architecture', defaultBranch: 'main' });

fake.control = (method, url, body) => {
  const b = (body ?? {}) as Record<string, unknown>;
  let m: RegExpMatchArray | null;
  if (method === 'GET' && url.pathname === '/_fake/pulls') {
    return { pulls: [...repo.pulls.values()].map((p) => ({ number: p.number, state: p.state, merged: p.merged, head: p.head, reviews: p.reviews })) };
  }
  if (method === 'GET' && url.pathname === '/_fake/files') {
    const files = fake.files(repo, url.searchParams.get('branch') ?? repo.defaultBranch);
    if (!files) throw new Error('no such branch');
    return { files: Object.fromEntries(files) };
  }
  if (method === 'POST' && (m = url.pathname.match(/^\/_fake\/pulls\/(\d+)\/(reviews|check-runs|merge|close)$/))) {
    const number = Number(m[1]);
    const pull = fake.pull(repo, number);
    switch (m[2]) {
      case 'reviews':
        fake.addReview(repo, number, String(b.login), b.state as FakeReview['state']);
        break;
      case 'check-runs': {
        const head = fake.headOf(repo, pull.head);
        const run: FakeCheckRun = { name: String(b.name), status: (b.status as FakeCheckRun['status']) ?? 'completed', conclusion: (b.conclusion as string | undefined) ?? 'success' };
        fake.setCheckRuns(repo, head, [...(repo.checkRuns.get(head) ?? []).filter((r) => r.name !== run.name), run]);
        break;
      }
      case 'merge':
        fake.mergePull(repo, number, { by: typeof b.by === 'string' ? b.by : undefined });
        break;
      case 'close':
        fake.closePull(repo, number);
        break;
    }
    return { ok: true };
  }
  throw new Error(`no control route for ${method} ${url.pathname}`);
};

await fake.start(port);
writeFileSync(keyFile, Buffer.from(fake.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'));
console.log(`fake-github ready on ${fake.url} (app id ${fake.appId}, key in ${keyFile})`);
const stop = () => void fake.stop().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
