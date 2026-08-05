import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase } from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';

/**
 * Contract for canvas-uw8's defense-in-depth guard in `resetDatabase()` (`tests/helpers/setup.ts`):
 * before running its `TRUNCATE`, it now queries `SELECT current_database()` and refuses to proceed
 * unless the connected database's name ends in `_test` — a second, independent safety net beyond
 * `config.ts`'s own hard test-mode override, in case some future code path bypasses `loadConfig()`.
 *
 * This exercises the real function against the real test database (`canvas_test`, which
 * `NODE_ENV=test` plus canvas-uw8's `loadConfig()` fix now guarantees for the whole suite) —
 * confirming the guard doesn't false-positive and block the suite's own normal, legitimate use.
 * The negative (refuses-to-truncate) path is covered separately in
 * `tests/unit/reset-database-guard.test.ts` against a mocked pool, rather than fabricating a
 * second, differently-named real database here.
 */
describe('resetDatabase() guard against non-test databases (canvas-uw8)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('is connected to a database whose name ends in _test', async () => {
    const pool = getPool();
    const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()');
    expect(rows[0].current_database).toMatch(/_test$/);
  });

  it('succeeds without throwing against the real canvas_test database', async () => {
    await expect(resetDatabase()).resolves.toBeUndefined();
  });
});
