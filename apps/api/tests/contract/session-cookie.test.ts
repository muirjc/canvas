import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closeTestDb, resetDatabase, seedUser } from '../helpers/setup.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * canvas-azure-deploy: a split-origin deployment (a static-hosted frontend calling a separately
 * hosted API, e.g. Azure) needs SameSite=None + Secure session cookies -- SameSite=Lax cookies are
 * never attached to cross-site fetch/XHR calls, only top-level navigation, so a login that
 * "succeeds" (200, correct body) can still leave the browser never actually holding a usable
 * session. Found live: exactly this happened on a real Azure deployment. Two things are under
 * test here: (1) loadConfig's cookieSecure/cookieSameSite flow through into the actual Set-Cookie
 * header @fastify/session emits, and (2) app.ts's trustProxy setting lets a Secure cookie be
 * issued when the request arrives from behind a TLS-terminating reverse proxy (X-Forwarded-Proto:
 * https) even though the connection to this process itself is plain HTTP, exactly how Azure App
 * Service (and most PaaS reverse proxies) forward requests internally.
 */
describe('session cookie attributes', () => {
  async function buildAppWithConfig(overrides: Partial<ReturnType<typeof loadConfig>>): Promise<FastifyInstance> {
    process.env.NODE_ENV = 'test';
    const config = { ...loadConfig(), allowLocalAuth: true, ...overrides };
    return buildApp({ config, logger: false });
  }

  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function login(instance: FastifyInstance, extraHeaders: Record<string, string> = {}) {
    await resetDatabase();
    await seedUser({ email: 'cookie-test@example.com', password: 'cookie-test-pass' });
    return instance.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      payload: { email: 'cookie-test@example.com', password: 'cookie-test-pass' },
    });
  }

  it('defaults to a same-origin-safe cookie (no Secure, SameSite=Lax)', async () => {
    app = await buildAppWithConfig({});
    const response = await login(app);
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((c) => c?.startsWith('sessionId='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).not.toMatch(/Secure/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });

  it('issues a Secure, SameSite=None cookie when configured for a split-origin deployment', async () => {
    app = await buildAppWithConfig({ cookieSecure: true, cookieSameSite: 'none' });
    const response = await login(app, { 'x-forwarded-proto': 'https' });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((c) => c?.startsWith('sessionId='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/Secure/i);
    expect(sessionCookie).toMatch(/SameSite=None/i);
  });

  it('a subsequent request carrying the session cookie is recognized as authenticated (the real regression)', async () => {
    app = await buildAppWithConfig({ cookieSecure: true, cookieSameSite: 'none' });
    const loginResponse = await login(app, { 'x-forwarded-proto': 'https' });
    const setCookie = loginResponse.headers['set-cookie'];
    const sessionCookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((c) => c?.startsWith('sessionId='))!;
    const cookieValue = sessionCookie.split(';')[0];

    const meResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: cookieValue, 'x-forwarded-proto': 'https' },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json().user.email).toBe('cookie-test@example.com');
  });
});
