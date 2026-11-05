import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../../../../scripts/dotenv.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/web/tests/e2e -> apps/web/tests -> apps/web -> apps -> repo root
const REPO_ROOT = path.resolve(__dirname, '../../../..');
/** canvas-mywp: the jobs run from apps/api-py, as the API does, so a relative SQLite path (./data/canvas.db)
 *  means the same file. */
const API_DIR = path.join(REPO_ROOT, 'apps', 'api-py');
/** A Python job in apps/api-py (canvas-1bty.16). */
const PY_JOB = 'uv run python -m canvas_api.jobs.';

/**
 * canvas-i86: every e2e spec reads `process.env.E2E_PROJECT_ID`, skipping itself if it's unset —
 * but nothing ever SET it beyond a developer/agent manually running the demo seed and copying its
 * printed id into their shell by hand. That id inevitably drifted stale (the seeded "Smoke Test"
 * project got deleted at some point this session, likely by an unrelated delete-project test/
 * script run, and the hardcoded id kept getting reused anyway) once nothing was left to notice or
 * self-correct.
 *
 * The demo seed (apps/api-py's `python -m canvas_api.jobs.seed_demo`) already looks up-or-creates a project literally named
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
  // The Python jobs read their settings from the environment only, so every invocation needs
  // these two explicitly. Falls back to this repo's own standard local dev values (used
  // consistently everywhere else — apps/api-py/.env.example, RUNBOOK.md) if a developer hasn't already
  // exported their own.
  // canvas-mywp: apps/api-py/.env (the settings the local API runs with) fills in what the environment doesn't
  // set, so the jobs use the API's own database, SQLite or Postgres, with no variables to export by hand.
  const fileEnv: Record<string, string> = readEnvFile(path.join(API_DIR, '.env'));
  const env = {
    ...fileEnv,
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      fileEnv.DATABASE_URL ??
      'postgres://canvas:canvas_dev_password@localhost:5433/canvas',
    SESSION_SECRET:
      process.env.SESSION_SECRET ??
      fileEnv.SESSION_SECRET ??
      'change-me-to-a-random-string-of-at-least-32-characters',
  };

  // canvas-fbv: each local run used to leave hundreds of diagrams in the shared "Smoke Test"
  // project, slowing every spec that renders it. Clear them first (the e2e_reset job) -- local
  // runs only: CI starts from an empty database. E2E_KEEP_DATA=1 skips it, e.g. to inspect what
  // a previous run left behind.
  if (!process.env.CI && !process.env.E2E_KEEP_DATA) {
    const reset = execSync(`${PY_JOB}e2e_reset`, { cwd: API_DIR, encoding: 'utf-8', env });
    const summary = reset.match(/e2e reset: .*/);
    if (summary) console.log(summary[0]);
  }

  if (process.env.E2E_PROJECT_ID) return;

  const output = execSync(`${PY_JOB}seed_demo`, {
    cwd: API_DIR,
    encoding: 'utf-8',
    env,
  });
  const match = output.match(/Project id: (\S+)/);
  if (!match) {
    throw new Error(
      'global-setup: the demo seed (canvas_api.jobs.seed_demo) did not print a "Project id: <uuid>" ' +
        'line — cannot resolve E2E_PROJECT_ID. Output was:\n' +
        output,
    );
  }
  process.env.E2E_PROJECT_ID = match[1];
}
