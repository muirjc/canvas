import { loadConfig } from '../config.js';
import { closeDb } from '../db/client.js';
import { GitHubClient } from './github-client.js';
import { syncOpenSubmissions } from './status-sync.service.js';

/**
 * canvas-3s5.2: syncs every open pull request Canvas opened with GitHub -- merged = approved,
 * closed = rejected, open = its review and check state. Run on a schedule (Azure: the
 * canvas-github-sync Container Apps Job, every 15 minutes); the editor also refreshes on demand.
 *
 * Usage: npm run github-sync --workspace=@canvas/api
 */
async function run(): Promise<void> {
  const config = loadConfig();
  if (!config.github) {
    console.log('GitHub is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY) -- nothing to sync.');
    return;
  }
  const counts = await syncOpenSubmissions(new GitHubClient(config.github));
  console.log(
    `Synced pull requests: ${counts.open} still open, ${counts.merged} merged (approved), ${counts.closed} closed (rejected), ${counts.error} failed.`,
  );
  if (counts.error > 0) process.exitCode = 1;
}

run()
  .then(() => closeDb())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    return closeDb();
  });
