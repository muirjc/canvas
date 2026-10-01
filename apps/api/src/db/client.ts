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
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import { loadConfig } from '../config.js';
import type { DB } from './schema.js';

/**
 * A function that needs to run either standalone or composed into a caller's own transaction
 * should take this instead of `Kysely<DB>` directly — `Transaction<DB>` has the identical
 * query-builder interface, so a `DbExecutor` works unchanged either way. This is the general fix
 * for the "Postgres driver types leak into service signatures" problem the canvas-jtm audit found
 * in `diagrams/version.service.ts`'s `pg.PoolClient`-typed `recordDiagramVersion` — introduced here
 * because canvas-jtm.3's own array-column write helpers (`db/array-columns.ts`) need it first
 * (they must run inside whichever transaction their caller is already in, e.g.
 * `createDraftStandard` writing a standard row and its shape lists atomically); every remaining
 * `pg.PoolClient` parameter is converted to this same type in canvas-jtm.4.
 */
export type DbExecutor = Kysely<DB> | Transaction<DB>;

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
