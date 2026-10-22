import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';

/**
 * canvas-ez1.1: AUTH_MODE picks the sign-in model. 'local' (option B,
 * docs/ip-allowlist-security-plan.md) serves only Canvas-managed email + password sign-in -- the
 * Entra routes don't exist even when OIDC_* is configured -- and /auth/config says so, which is
 * what the sign-in page shows its form from.
 */
describe('AUTH_MODE', () => {
  let app: FastifyInstance | undefined;
  const ENTRA = {
    OIDC_ISSUER_URL: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0',
    OIDC_CLIENT_ID: 'client',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  };

  async function start(env: Record<string, string>): Promise<FastifyInstance> {
    app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', ...env }), logger: false });
    return app;
  }

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedUser({ email: 'local@example.com', password: 'local-pass' });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('local: /auth/config reports local sign-in only, and email + password sign-in works', async () => {
    const instance = await start({ AUTH_MODE: 'local', ...ENTRA });
    const config = await instance.inject({ method: 'GET', url: '/auth/config' });
    expect(config.json()).toEqual({ authMode: 'local', oidcEnabled: false, localAuthEnabled: true });

    const login = await instance.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'local@example.com', password: 'local-pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('local: the Entra routes do not exist even though OIDC_* is set', async () => {
    const instance = await start({ AUTH_MODE: 'local', ...ENTRA });
    expect((await instance.inject({ method: 'GET', url: '/auth/login' })).statusCode).toBe(404);
    expect((await instance.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' })).statusCode).toBe(404);
  });

  it('entra (the default) without ALLOW_LOCAL_AUTH: no local sign-in route', async () => {
    const instance = await start({});
    const config = await instance.inject({ method: 'GET', url: '/auth/config' });
    expect(config.json()).toMatchObject({ authMode: 'entra', localAuthEnabled: false });
    const login = await instance.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'local@example.com', password: 'local-pass' },
    });
    expect(login.statusCode).toBe(404);
  });
});
