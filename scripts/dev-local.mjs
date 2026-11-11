// canvas-mywp: `npm run dev:local` -- runs Canvas on this machine with no containers: the API (uvicorn) and the
// web app (Vite) together, both stopped by Ctrl-C. On first run it creates apps/api-py/.env from .env.example
// (SQLite, demo sign-in) and, for a new SQLite database, seeds the demo data; otherwise it applies any pending
// migrations. Settings come from apps/api-py/.env; the process environment wins over it, as with
// `uv run --env-file`. API_PORT / WEB_PORT pick other ports (default 3000 / 5173). `--seed` runs the demo seed
// again (it only adds what's missing). Works on Windows too (needs Node 26 and uv on PATH).
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './dotenv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'apps', 'api-py');
const ENV_FILE = join(API_DIR, '.env');
const API_PORT = process.env.API_PORT ?? '3000';
const WEB_PORT = process.env.WEB_PORT ?? '5173';
const WINDOWS = process.platform === 'win32';

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: WINDOWS, ...options });
  if (result.status !== 0) {
    // A local developer tool reporting which of its own commands failed; no user data.
    // bearer:disable javascript_lang_logger_leak
    console.error(`\n${command} ${args.join(' ')} failed (exit ${result.status ?? result.signal}).`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(ENV_FILE)) {
  copyFileSync(join(API_DIR, '.env.example'), ENV_FILE);
  console.log('Created apps/api-py/.env from .env.example (SQLite database, demo sign-in).');
}
const apiEnv = { ...readEnvFile(ENV_FILE), ...process.env };
// The web app's address must be allowed to call the API with its session cookie.
const webOrigin = `http://localhost:${WEB_PORT}`;
const origins = (apiEnv.WEB_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
if (!origins.includes(webOrigin)) apiEnv.WEB_ORIGINS = [...origins, webOrigin].join(',');

// The web app resolves diagram-core through its built output.
if (!existsSync(join(ROOT, 'packages', 'diagram-core', 'dist', 'index.js'))) {
  console.log('Building packages/diagram-core (first run)...');
  run('npm', ['run', 'build', '--workspace=@canvas/diagram-core'], { cwd: ROOT });
}

const sqliteFile =
  apiEnv.DB_CLIENT === 'sqlite' && apiEnv.DATABASE_URL && apiEnv.DATABASE_URL !== ':memory:'
    ? isAbsolute(apiEnv.DATABASE_URL)
      ? apiEnv.DATABASE_URL
      : resolve(API_DIR, apiEnv.DATABASE_URL)
    : undefined;
const job = (name) => run('uv', ['run', 'python', '-m', `canvas_api.jobs.${name}`], { cwd: API_DIR, env: apiEnv });
if (process.argv.includes('--seed') || (sqliteFile && !existsSync(sqliteFile))) {
  console.log('Setting up the database with demo data (the demo seed migrates first)...');
  job('seed_demo');
} else {
  job('migrate');
}

/** Starts a long-running process, prefixing each output line with its name. */
function start(name, command, args, options) {
  // Its own process group (not on Windows), so stopping it reaches what npm and uv start under it.
  const child = spawn(command, args, { shell: WINDOWS, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? '';
      // Passing the API's and Vite's own output through to the developer's terminal is the point of this script.
      // bearer:disable javascript_lang_logger_leak
      for (const line of lines) console.log(`[${name}] ${line}`);
    });
  }
  return child;
}

const children = [
  start('api', 'uv', ['run', 'uvicorn', 'canvas_api.main:app', '--host', '127.0.0.1', '--port', API_PORT, '--reload'], {
    cwd: API_DIR,
    env: apiEnv,
  }),
  start('web', 'npm', ['run', 'dev', '--workspace=@canvas/web', '--', '--port', WEB_PORT, '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? `http://localhost:${API_PORT}` },
  }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // npm (and a shell on Windows) don't pass a signal on: end the whole process tree / group.
    if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('exit', (code) => {
    // An exit code only.
    // bearer:disable javascript_lang_logger_leak
    if (!stopping) console.error(`\nA process stopped (exit ${code}); stopping the other.`);
    stop(code ?? 1);
  });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

// The local addresses (port numbers) only.
// bearer:disable javascript_lang_logger_leak
console.log(`\nCanvas: http://localhost:${WEB_PORT}  (API http://localhost:${API_PORT}). Ctrl-C stops both.`);
console.log('Demo sign-in, once the demo data is seeded: admin@example.com / admin-dev-password.\n');
