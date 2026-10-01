/**
 * Kysely singleton (canvas-jtm Phase 0 — see
 * /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md). Postgres-only for now, mirroring
 * `db/pool.ts`'s own lazy-singleton shape exactly — this module is the engine-agnostic replacement
 * for it, grown dialect-by-dialect across the phases rather than in one step.
 *
 * `DB_CLIENT`/`DATABASE_URL`-scheme dialect selection and a SQLite dialect both arrive in a later
 * phase (canvas-jtm.6/.7); until then this is a drop-in, behavior-identical Kysely wrapper around
 * the exact same `pg.Pool` `db/pool.ts` already constructs, so files can migrate to it one at a
 * time with zero observable change while `pool.ts` is still used by everything not yet converted.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { loadConfig } from '../config.js';
import type { DB } from './schema.js';

let db: Kysely<DB> | undefined;

export function getDb(): Kysely<DB> {
  if (!db) {
    const config = loadConfig();
    db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: config.databaseUrl }),
      }),
    });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = undefined;
  }
}
