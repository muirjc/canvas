import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/web/tests/e2e -> apps/web/tests -> apps/web -> apps -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * canvas-i86: every e2e spec reads `process.env.E2E_PROJECT_ID`, skipping itself if it's unset —
 * but nothing ever SET it beyond a developer/agent manually running `npm run seed` and copying its
 * printed id into their shell by hand. That id inevitably drifted stale (the seeded "Smoke Test"
 * project got deleted at some point this session, likely by an unrelated delete-project test/
 * script run, and the hardcoded id kept getting reused anyway) once nothing was left to notice or
 * self-correct.
 *
 * `npm run seed` (apps/api/src/seed/run.ts) already looks up-or-creates a project literally named
 * "Smoke Test" — idempotent, safe to run before every suite. Running it here and parsing its own
 * printed id means E2E_PROJECT_ID is always resolved fresh, correct, and self-healing (if "Smoke
 * Test" is ever deleted again, the next run just recreates it under a new id and picks that up)
 * instead of a value a human has to remember to keep in sync.
 *
 * An explicitly-set E2E_PROJECT_ID (e.g. CI's own workflow, which seeds once and exports it via
 * GITHUB_ENV before Playwright ever starts) always wins — this only fills the gap for local/dev
 * runs where nothing has set it yet.
 */
export default function globalSetup(): void {
  if (process.env.E2E_PROJECT_ID) return;

  // apps/api's scripts (dev/migrate/seed) never auto-load apps/api/.env — this repo has no
  // dotenv dependency at all, that file is reference/documentation only, and every invocation
  // needs these two explicitly. Falls back to this repo's own standard local dev values (used
  // consistently everywhere else — apps/api/.env, RUNBOOK.md) if a developer hasn't already
  // exported their own.
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://canvas:canvas_dev_password@localhost:5433/canvas',
    SESSION_SECRET: process.env.SESSION_SECRET ?? 'change-me-to-a-random-string-of-at-least-32-characters',
  };

  const output = execSync('npm run seed --workspace=@canvas/api', {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
  });
  const match = output.match(/Project id: (\S+)/);
  if (!match) {
    throw new Error(
      'global-setup: `npm run seed --workspace=@canvas/api` did not print a "Project id: <uuid>" ' +
        'line — cannot resolve E2E_PROJECT_ID. Output was:\n' + output,
    );
  }
  process.env.E2E_PROJECT_ID = match[1];
}
