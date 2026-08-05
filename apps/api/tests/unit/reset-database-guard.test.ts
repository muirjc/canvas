import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the negative path of canvas-uw8's `resetDatabase()` guard: it must
 * refuse to run its `TRUNCATE` against a database whose name doesn't end in `_test`, even if
 * something upstream of it (a future code path bypassing `loadConfig()`'s own hard override)
 * pointed it at a differently-named database.
 *
 * The real guard needs a real Postgres connection to call `current_database()`; exercising the
 * actual throw path against a real non-`_test`-named database would mean creating one, which this
 * task explicitly rules out (must not create/touch any database other than `canvas_test`, and
 * never the real dev `canvas` database). Instead, this mocks `src/db/pool.js` — the one true
 * external boundary here — so `resetDatabase()`'s own guard logic runs for real against a fake
 * `current_database()` result, with no real second database involved anywhere.
 */
const queryMock = vi.fn();

vi.mock('../../src/db/pool.js', () => ({
  getPool: () => ({ query: queryMock }),
  closePool: vi.fn(),
}));

describe('resetDatabase() guard against non-test databases (canvas-uw8)', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('refuses to TRUNCATE when connected to a database not named *_test', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ current_database: 'canvas' }] });

    const { resetDatabase } = await import('../helpers/setup.js');
    await expect(resetDatabase()).rejects.toThrow(
      /resetDatabase\(\) refused to TRUNCATE database "canvas"/,
    );

    // The guard must reject BEFORE issuing the TRUNCATE — only the SELECT current_database()
    // query should ever have run.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith('SELECT current_database()');
  });

  it('proceeds to TRUNCATE when connected to a database named *_test', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ current_database: 'canvas_test' }] }); // SELECT current_database()
    queryMock.mockResolvedValueOnce({}); // TRUNCATE ...
    queryMock.mockResolvedValueOnce({}); // UPDATE ai_settings ...

    const { resetDatabase } = await import('../helpers/setup.js');
    await expect(resetDatabase()).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(3);
  });
});
