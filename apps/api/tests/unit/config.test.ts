import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

/**
 * Regression coverage for canvas-uw8: `loadConfig()`'s test-mode database/session values used to
 * be a soft fallback (`env.DATABASE_URL ?? '<canvas_test URL>'`), so an ambient `DATABASE_URL`
 * already exported in a developer's shell (e.g. from a concurrently-running `npm run dev`
 * pointing at the real dev database) silently leaked into the test suite, pointing
 * `resetDatabase()`'s TRUNCATE at the real dev database instead of the isolated `canvas_test` one.
 * `loadConfig()` now hard-overrides `databaseUrl`/`sessionSecret` whenever `NODE_ENV === 'test'`,
 * ignoring whatever is already present in the environment, no matter what it is.
 *
 * NOTE on the non-test-mode tests below: `requireEnv()` (used for `databaseUrl`/`sessionSecret`
 * outside test mode) reads real `process.env` directly rather than the `env` argument passed into
 * `loadConfig()` — true both before and after canvas-uw8's fix (confirmed via `git diff`; this
 * predates the fix and canvas-uw8 does not touch it). So passing an `env` object only actually
 * controls `databaseUrl`/`sessionSecret` on the test-mode branch, which never calls `requireEnv`
 * at all — outside test mode, a passed-in `DATABASE_URL`/`SESSION_SECRET` would be silently
 * ignored in favor of real `process.env`. The two non-test-mode cases below stub real
 * `process.env` (saved/restored per test) instead, so they exercise the code's actual behavior
 * rather than an assumption about the `env` parameter that doesn't hold for these two keys.
 */
describe('loadConfig()', () => {
  it('ignores an ambient DATABASE_URL/SESSION_SECRET in test mode — uses the fixed test values', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://someone:else@somewhere/canvas',
      SESSION_SECRET: 'whatever-someone-set',
    });

    expect(config.databaseUrl).toBe('postgres://canvas:canvas_dev_password@localhost:5433/canvas_test');
    expect(config.sessionSecret).toBe('test-secret-at-least-32-characters-long');
  });

  it('uses the real DATABASE_URL/SESSION_SECRET outside test mode', () => {
    const originalDbUrl = process.env.DATABASE_URL;
    const originalSecret = process.env.SESSION_SECRET;
    process.env.DATABASE_URL = 'postgres://real/db';
    process.env.SESSION_SECRET = 'real-secret-long-enough';
    try {
      const config = loadConfig({ NODE_ENV: 'production' });
      expect(config.databaseUrl).toBe('postgres://real/db');
      expect(config.sessionSecret).toBe('real-secret-long-enough');
    } finally {
      if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDbUrl;
      if (originalSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSecret;
    }
  });

  it('still throws when DATABASE_URL/SESSION_SECRET are genuinely unset outside test mode', () => {
    const originalDbUrl = process.env.DATABASE_URL;
    const originalSecret = process.env.SESSION_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_SECRET;
    try {
      expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
        'Missing required environment variable: DATABASE_URL',
      );
    } finally {
      if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDbUrl;
      if (originalSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = originalSecret;
    }
  });
});
