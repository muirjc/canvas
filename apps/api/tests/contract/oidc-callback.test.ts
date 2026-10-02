import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { closeTestDb, resetDatabase } from '../helpers/setup.js';

/**
 * canvas-haz.5 (Phase 4 of the Keycloak -> Entra migration, the NFR-2 test gate the migration
 * spec itself calls for): drives the real `/auth/login` -> `/auth/callback` flow against a fully
 * real `openid-client`/`oauth4webapi` -- NOT mocked, unlike `tests/unit/oidc.test.ts` -- with only
 * `global.fetch` stubbed to serve a locally-controlled fake Entra discovery document, JWKS, and
 * token endpoint. This is the only place in the suite that actually exercises
 * `client.enableNonRepudiationChecks`'s real JWS signature verification end to end: every
 * rejection case below (tampered signature, wrong key, unknown kid, ...) fails specifically
 * because that hardening is in place, confirmed during development by temporarily removing
 * `client.enableNonRepudiationChecks` from oidc.ts and watching the tampered-signature/wrong-key
 * cases below start passing with a forged token instead of rejecting it.
 */

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const AUTHORIZATION_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`;
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const JWKS_URI = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;
const END_SESSION_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout`;
const CLIENT_ID = 'test-client-id';
const REDIRECT_URI = 'http://localhost:3000/auth/callback';
const WEB_ORIGIN = 'http://localhost:5173';
const KID = 'test-signing-key';

function discoveryDocument(): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    jwks_uri: JWKS_URI,
    end_session_endpoint: END_SESSION_ENDPOINT,
    response_types_supported: ['code'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile'],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let realPrivateKey: KeyLike;
let realPublicJwk: Record<string, unknown>;
let otherPrivateKey: KeyLike;

/** Set per-test via `setTokenEndpointResponse()`; read by the fetch stub's token-endpoint route. */
let tokenEndpointBody: Record<string, unknown> | null = null;

function setTokenEndpointResponse(idToken: string): void {
  tokenEndpointBody = { token_type: 'Bearer', access_token: 'test-access-token', expires_in: 3600, id_token: idToken };
}

async function signIdToken(
  privateKey: KeyLike,
  claims: Record<string, unknown>,
  options: { kid?: string; alg?: string } = {},
): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID }).sign(privateKey);
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'entra-oid-12345',
    iat: now,
    exp: now + 3600,
    email: 'jane.doe@contoso.com',
    name: 'Jane Doe',
    roles: ['admin'],
    ...overrides,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  const real = await generateKeyPair('RS256');
  realPrivateKey = real.privateKey;
  const jwk = await exportJWK(real.publicKey);
  realPublicJwk = { ...jwk, kid: KID, alg: 'RS256', use: 'sig' };

  // A second, never-published keypair -- used to prove signature verification actually checks the
  // cryptographic signature, not just that *some* `kid` header is present. Signs a token claiming
  // the SAME `kid` as the real published key, but with a private key the published JWKS never
  // advertises -- verification must still fail.
  const other = await generateKeyPair('RS256');
  otherPrivateKey = other.privateKey;

  await runMigrations();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetDatabase();
  tokenEndpointBody = null;

  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse(discoveryDocument());
    if (url === JWKS_URI) return jsonResponse({ keys: [realPublicJwk] });
    if (url === TOKEN_ENDPOINT) {
      if (!tokenEndpointBody) throw new Error('Test token endpoint called with no response configured');
      return jsonResponse(tokenEndpointBody);
    }
    throw new Error(`Unexpected fetch() call in oidc-callback.test.ts to: ${url}`);
  });

  process.env.NODE_ENV = 'test';
  const config = loadConfig();
  config.oidc = { issuerUrl: ISSUER, clientId: CLIENT_ID, clientSecret: 'test-client-secret', redirectUri: REDIRECT_URI };
  config.webOrigins = [WEB_ORIGIN];
  app = await buildApp({ config, logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

/** Drives GET /auth/login and extracts what the callback needs: the session cookie (PKCE
 *  verifier/state/nonce all live server-side in it) and the state/nonce values the IdP would echo
 *  back (read from the authorization redirect's own query string, exactly as a real browser would
 *  carry them through the IdP round-trip). */
async function startLogin(): Promise<{ cookie: string; state: string; nonce: string }> {
  const response = await app.inject({ method: 'GET', url: '/auth/login' });
  expect(response.statusCode).toBe(302);
  const location = new URL(response.headers.location as string);
  const setCookie = response.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
    (c): c is string => typeof c === 'string' && c.startsWith('sessionId='),
  );
  if (!cookie) throw new Error('expected a sessionId cookie from GET /auth/login');
  return {
    cookie: cookie.split(';')[0],
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
  };
}

async function callback(cookie: string, state: string): Promise<{ statusCode: number; json: () => unknown }> {
  return app.inject({ method: 'GET', url: `/auth/callback?code=test-code&state=${encodeURIComponent(state)}`, headers: { cookie } });
}

describe('OIDC callback against a real openid-client validation pipeline (canvas-haz.5)', () => {
  it('happy path: establishes a session, creates a user with the mapped role, and sets up logout', async () => {
    const { cookie, state, nonce } = await startLogin();
    setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce })));

    const response = await callback(cookie, state);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(WEB_ORIGIN);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: 'jane.doe@contoso.com', name: 'Jane Doe', role: 'admin' });

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const logoutUrl = new URL(logout.json().logoutUrl);
    expect(logoutUrl.origin + logoutUrl.pathname).toBe(END_SESSION_ENDPOINT);
    expect(logoutUrl.searchParams.get('post_logout_redirect_uri')).toBe(WEB_ORIGIN);

    const db = getDb();
    const row = await db.selectFrom('users').select(['email', 'role']).where('email', '=', 'jane.doe@contoso.com').executeTakeFirst();
    expect(row).toMatchObject({ email: 'jane.doe@contoso.com', role: 'admin' });
  });

  it('maps multiple roles to the highest-privilege one', async () => {
    const { cookie, state, nonce } = await startLogin();
    setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce, roles: ['viewer', 'architect'] })));

    await callback(cookie, state);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().user.role).toBe('architect');
  });

  it('defaults to viewer when the roles claim is absent', async () => {
    const { cookie, state, nonce } = await startLogin();
    const claims = baseClaims({ nonce });
    delete claims.roles;
    setTokenEndpointResponse(await signIdToken(realPrivateKey, claims));

    await callback(cookie, state);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().user.role).toBe('viewer');
  });

  it('ignores a Keycloak-shaped nested realm_access.roles claim -- defaults to viewer, does not read the old IdP shape', async () => {
    const { cookie, state, nonce } = await startLogin();
    const claims = baseClaims({ nonce, realm_access: { roles: ['admin'] } });
    delete claims.roles;
    setTokenEndpointResponse(await signIdToken(realPrivateKey, claims));

    await callback(cookie, state);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().user.role).toBe('viewer');
  });

  it('re-syncs role on a second login when the IdP-asserted role changed', async () => {
    const first = await startLogin();
    setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce: first.nonce, roles: ['admin'] })));
    await callback(first.cookie, first.state);

    const second = await startLogin();
    setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce: second.nonce, roles: ['viewer'] })));
    await callback(second.cookie, second.state);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: second.cookie } });
    expect(me.json().user.role).toBe('viewer');

    const db = getDb();
    const rows = await db.selectFrom('users').select('email').where('email', '=', 'jane.doe@contoso.com').execute();
    expect(rows).toHaveLength(1); // re-synced the existing row, did not create a second account
  });

  it('rejects an inactive user with 403 and does not establish a session', async () => {
    const { cookie, state, nonce } = await startLogin();
    setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce })));
    await callback(cookie, state); // creates the user

    const db = getDb();
    await db.updateTable('users').set({ active: false }).where('email', '=', 'jane.doe@contoso.com').execute();

    const second = await startLogin();
    setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce: second.nonce })));
    const response = await callback(second.cookie, second.state);
    expect(response.statusCode).toBe(403);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: second.cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('responds 403, not a raw 500, when Entra redirects back with its own ?error=... params (e.g. an unassigned user)', async () => {
    const { cookie, state } = await startLogin();
    const response = await app.inject({
      method: 'GET',
      url: `/auth/callback?error=access_denied&error_description=${encodeURIComponent('AADSTS50105: user not assigned')}&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'You are not authorized to access this application.' });
  });

  describe('rejects with 401 and creates no user row', () => {
    async function expectRejected(cookie: string, state: string): Promise<void> {
      const response = await callback(cookie, state);
      expect(response.statusCode).toBe(401);
      const db = getDb();
      const rows = await db.selectFrom('users').select('email').execute();
      expect(rows).toHaveLength(0);
    }

    it('a tampered payload (signature no longer matches)', async () => {
      const { cookie, state, nonce } = await startLogin();
      const token = await signIdToken(realPrivateKey, baseClaims({ nonce }));
      const [header, payload, signature] = token.split('.');
      const tamperedPayload = Buffer.from(payload, 'base64url').toString('utf8').replace('"admin"', '"viewer"');
      const forged = `${header}.${Buffer.from(tamperedPayload, 'utf8').toString('base64url')}.${signature}`;
      setTokenEndpointResponse(forged);
      await expectRejected(cookie, state);
    });

    it('signed with a different key under the same kid', async () => {
      const { cookie, state, nonce } = await startLogin();
      setTokenEndpointResponse(await signIdToken(otherPrivateKey, baseClaims({ nonce }), { kid: KID }));
      await expectRejected(cookie, state);
    });

    it('an unknown kid not present in the published JWKS', async () => {
      const { cookie, state, nonce } = await startLogin();
      setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce }), { kid: 'no-such-key' }));
      await expectRejected(cookie, state);
    });

    it('wrong audience', async () => {
      const { cookie, state, nonce } = await startLogin();
      setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce, aud: 'some-other-client-id' })));
      await expectRejected(cookie, state);
    });

    it('wrong issuer (the Keycloak-era-equivalent v1 issuer form)', async () => {
      const { cookie, state, nonce } = await startLogin();
      setTokenEndpointResponse(
        await signIdToken(realPrivateKey, baseClaims({ nonce, iss: `https://sts.windows.net/${TENANT_ID}/` })),
      );
      await expectRejected(cookie, state);
    });

    it('an expired token', async () => {
      const { cookie, state, nonce } = await startLogin();
      const now = Math.floor(Date.now() / 1000);
      setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce, iat: now - 7200, exp: now - 3600 })));
      await expectRejected(cookie, state);
    });

    it('a wrong nonce', async () => {
      const { cookie, state } = await startLogin();
      setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce: 'wrong-nonce-value' })));
      await expectRejected(cookie, state);
    });

    it('a mismatched state', async () => {
      const { cookie, nonce } = await startLogin();
      setTokenEndpointResponse(await signIdToken(realPrivateKey, baseClaims({ nonce })));
      await expectRejected(cookie, 'completely-wrong-state');
    });
  });
});
