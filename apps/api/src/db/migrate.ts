/**
 * Minimal, dependency-free SQL migration runner (Constitution VI — no ORM/migration-framework
 * machinery beyond what's needed). Applies numbered .sql files in order, tracking applied
 * migrations in a `schema_migrations` table. Dialect-aware (canvas-jtm.7): Postgres keeps its own
 * independent `pg.Pool` (via `db/pool.ts`) and reads `apps/api/migrations/*.sql`; SQLite reads the
 * one squashed `apps/api/migrations/sqlite/0001_init.sql` (see that file's own header for why a
 * single file, not a replay of all 13 Postgres migrations) and MUST run against the exact same
 * connection the rest of the process uses (`db/client.ts`'s `getDb()`), not a second one of its
 * own — a `:memory:` SQLite database is private to the connection that opened it, so a
 * second, independent connection (the Postgres design's whole premise: migrations and app queries
 * can safely use separate connections to the same server) would silently migrate a database no
 * app query can ever see. This is the one place this plan asks the migration runner to pick
 * between two dialect-specific code paths, not grow a shared templating/diffing layer — see the
 * plan's own "Migration-runner scope creep" risk note.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { getPool, closePool } from './pool.js';
import { getDb, closeDb, getSqliteRawDatabase } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POSTGRES_MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const SQLITE_MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations', 'sqlite');

async function runPostgresMigrations(): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(POSTGRES_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(POSTGRES_MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

function runSqliteMigrations(): string[] {
  // Ensures db/client.ts's singleton sqlite connection exists before reading it — the very first
  // call in a process (e.g. buildTestApp()) is this one, so getDb() can't be assumed already
  // called.
  getDb();
  const sqliteDb = getSqliteRawDatabase();

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const files = readdirSync(SQLITE_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = sqliteDb.prepare('SELECT filename FROM schema_migrations').all() as { filename: string }[];
  const applied = new Set(appliedRows.map((r) => r.filename));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(SQLITE_MIGRATIONS_DIR, file), 'utf8');
    const runInTransaction = sqliteDb.transaction(() => {
      sqliteDb.exec(sql);
      sqliteDb.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    });
    try {
      runInTransaction();
      newlyApplied.push(file);
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return newlyApplied;
}

export async function runMigrations(): Promise<string[]> {
  const config = loadConfig();
  return config.dbClient === 'sqlite' ? runSqliteMigrations() : runPostgresMigrations();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runMigrations()
    .then((applied) => {
      if (applied.length === 0) {
        console.log('No pending migrations.');
      } else {
        console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
      }
      return Promise.all([closeDb(), closePool()]);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      return Promise.all([closeDb(), closePool()]);
    });
}
