/**
 * Kysely singleton (canvas-jtm — see /home/jmuir/.claude/plans/we-need-to-make-graceful-ocean.md).
 * Dialect is chosen from `config.dbClient` (canvas-jtm.7): Postgres via `pg.Pool` as before, or
 * SQLite via `better-sqlite3` for local dev/small-deployment/test use (see
 * `apps/api/migrations/sqlite/0001_init.sql`'s own header comment for the concurrency caveat).
 */
import { Kysely, PostgresDialect, SqliteDialect, type Transaction } from 'kysely';
import Database from 'better-sqlite3';
import pg from 'pg';
import { loadConfig } from '../config.js';
import type { DB } from './schema.js';
import { SqliteJsonColumnsPlugin } from './sqlite-json-plugin.js';
import { SqliteValueCoercionPlugin } from './sqlite-value-coercion-plugin.js';

type SqliteDatabase = InstanceType<typeof Database>;

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
let sqliteRawDb: SqliteDatabase | undefined;

export function getDb(): Kysely<DB> {
  if (!db) {
    const config = loadConfig();
    if (config.dbClient === 'sqlite') {
      sqliteRawDb = new Database(config.databaseUrl);
      // Off by default in SQLite, unlike Postgres — every join-table/cascade relationship in
      // schema.ts assumes real FK enforcement, so this isn't optional.
      sqliteRawDb.pragma('foreign_keys = ON');
      db = new Kysely<DB>({
        dialect: new SqliteDialect({ database: sqliteRawDb }),
        // Order matters: coercion runs on the way IN (query transform), JSON parsing on the way
        // OUT (result transform) — both apply to every query regardless of plugin order here, but
        // listed in that logical "write then read" sequence for clarity.
        plugins: [new SqliteValueCoercionPlugin(), new SqliteJsonColumnsPlugin()],
      });
    } else {
      db = new Kysely<DB>({
        dialect: new PostgresDialect({
          pool: new pg.Pool({ connectionString: config.databaseUrl }),
        }),
      });
    }
  }
  return db;
}

/**
 * The raw better-sqlite3 handle backing `getDb()`'s SQLite dialect — needed only by
 * `db/migrate.ts`, which must run its own multi-statement raw DDL through the exact same
 * connection `getDb()` already opened (a `:memory:` SQLite database is private to the connection
 * that created it; a second `new Database(':memory:')` would silently migrate a database no app
 * query can ever see). Throws if `getDb()` hasn't been called yet, or was called against Postgres
 * — callers must call `getDb()` first.
 */
export function getSqliteRawDatabase(): SqliteDatabase {
  if (!sqliteRawDb) {
    throw new Error('getSqliteRawDatabase() called before getDb() established a SQLite connection.');
  }
  return sqliteRawDb;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = undefined;
    sqliteRawDb = undefined;
  }
}
