import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closeTestDb, resetDatabase } from '../helpers/setup.js';
import { runMigrations } from '../../src/db/migrate.js';
import { registerSession, registerSessionInfoRoutes } from '../../src/auth/session.js';
import type { AppConfig } from '../../src/config.js';

/**
 * Reproduces the bug reported live against the Azure deployment: "Sign in with SSO" completes
 * a full, correct round trip through Keycloak (auth/oidc.ts's /auth/callback sets
 * request.session.user directly, no /auth/local/login involved), but the frontend's own
 * post-redirect session check (GET /auth/me, App.tsx) 404'd because /auth/me and /auth/logout
 * used to live inside auth/local.ts's registerLocalAuthRoutes, gated behind
 * config.allowLocalAuth -- which the Azure deployment deliberately defaults to false
 * (canvas-ycu.1, SSO-only). A completed SSO login could never be recognized, and the user landed
 * back on the login screen with no indication anything had happened.
 *
 * Every other contract test builds its app via tests/helpers/setup.ts, which forces
 * allowLocalAuth: true -- this is precisely why the gap was invisible to the existing suite.
 * This file deliberately builds its own app with allowLocalAuth: false to catch it.
 */
describe('session info routes (/auth/me, /auth/logout) with local auth disabled', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    await resetDatabase();
    process.env.NODE_ENV = 'test';
    const config = { ...loadConfig(), allowLocalAuth: false };
    app = await buildApp({ config, logger: false });
  });

  afterEach(async () => {
    // no-op: routes are stateless here, nothing to reset between assertions
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('GET /auth/me is registered (401, not 404) when unauthenticated', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('POST /auth/logout is registered (204, not 404) even with no active session', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(response.statusCode).toBe(204);
  });

  it('POST /auth/local/login stays disabled (404) — the gate still applies to password login itself', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nobody@example.com', password: 'irrelevant' },
    });
    expect(response.statusCode).toBe(404);
  });
});

/**
 * canvas-252: RP-Initiated Logout coverage for POST /auth/logout. Built as its own minimal
 * Fastify app (registerSession + registerSessionInfoRoutes directly, no database/migrations, no
 * full registerOidcRoutes/client.discovery() involved) rather than reusing buildApp() -- the
 * describe block above already establishes that `registerOidcRoutes` is what would normally
 * decorate `app.buildOidcLogoutUrl` (see oidc.test.ts's own dedicated coverage of that decoration
 * logic), so here it's faked directly to isolate session.ts's own branching logic. A test-only
 * route seeds `request.session.oidcIdToken` the same way auth/oidc.ts's real /auth/callback
 * handler does after a completed SSO round-trip, standing in for a full token-exchange mock (see
 * this file's own header comment for why a full callback-flow harness doesn't exist yet in this
 * suite).
 */
describe('POST /auth/logout with an SSO-established session (canvas-252)', () => {
  function testConfig(): AppConfig {
    return {
      port: 3000,
      databaseUrl: 'unused',
      sessionSecret: 'test-secret-at-least-32-characters-long',
      oidc: {},
      allowLocalAuth: false,
      webOrigins: ['http://localhost:5173'],
      cookieSecure: false,
      cookieSameSite: 'lax',
      enableApiDocs: false,
    };
  }

  async function buildSsoTestApp(decorateLogoutUrl: boolean): Promise<{
    app: FastifyInstance;
    buildOidcLogoutUrlMock: ReturnType<typeof vi.fn> | undefined;
  }> {
    const app = Fastify();
    await registerSession(app, testConfig());
    let buildOidcLogoutUrlMock: ReturnType<typeof vi.fn> | undefined;
    if (decorateLogoutUrl) {
      buildOidcLogoutUrlMock = vi.fn(
        (idTokenHint: string) => `https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout?id_token_hint=${idTokenHint}`,
      );
      app.decorate('buildOidcLogoutUrl', buildOidcLogoutUrlMock);
    }
    await registerSessionInfoRoutes(app);
    // Test-only route seeding session state directly -- mirrors what auth/oidc.ts's real
    // /auth/callback handler does (request.session.user + request.session.oidcIdToken) without
    // needing a real/mocked OIDC token exchange.
    app.post<{ Body: { oidcIdToken?: string } }>('/test/seed-session', async (request, reply) => {
      request.session.user = {
        id: 'sso-user-id',
        email: 'sso-user@example.com',
        name: 'SSO User',
        role: 'architect',
        personas: [],
      };
      if (request.body.oidcIdToken) request.session.oidcIdToken = request.body.oidcIdToken;
      reply.code(204).send();
    });
    await app.ready();
    return { app, buildOidcLogoutUrlMock };
  }

  function extractSessionCookie(response: { headers: Record<string, unknown> }): string {
    const setCookie = response.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
      (c): c is string => typeof c === 'string' && c.startsWith('sessionId='),
    );
    if (!cookie) throw new Error('expected a sessionId cookie in the response, found none');
    return cookie.split(';')[0];
  }

  it('returns 200 { logoutUrl } and really destroys the local session when oidcIdToken is present and buildOidcLogoutUrl is decorated', async () => {
    const { app, buildOidcLogoutUrlMock } = await buildSsoTestApp(true);

    const seedResponse = await app.inject({
      method: 'POST',
      url: '/test/seed-session',
      headers: { 'content-type': 'application/json' },
      payload: { oidcIdToken: 'the-id-token' },
    });
    const cookie = extractSessionCookie(seedResponse);

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.json()).toEqual({
      logoutUrl: 'https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout?id_token_hint=the-id-token',
    });
    expect(buildOidcLogoutUrlMock).toHaveBeenCalledWith('the-id-token');

    // Confirms the local session was really destroyed too, not just an extra field bolted onto
    // the response -- a subsequent request with the same cookie is unauthenticated.
    const meResponse = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(meResponse.statusCode).toBe(401);

    await app.close();
  });

  it('returns plain 204 (no Keycloak round-trip) when the session has no oidcIdToken, even though buildOidcLogoutUrl is decorated', async () => {
    const { app, buildOidcLogoutUrlMock } = await buildSsoTestApp(true);

    const seedResponse = await app.inject({
      method: 'POST',
      url: '/test/seed-session',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    const cookie = extractSessionCookie(seedResponse);

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(204);
    expect(logoutResponse.body).toBe('');
    expect(buildOidcLogoutUrlMock).not.toHaveBeenCalled();

    const meResponse = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(meResponse.statusCode).toBe(401);

    await app.close();
  });
});
