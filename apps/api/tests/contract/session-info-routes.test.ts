import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closeTestDb, resetDatabase } from '../helpers/setup.js';
import { runMigrations } from '../../src/db/migrate.js';

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
