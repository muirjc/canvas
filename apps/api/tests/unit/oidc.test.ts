import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEndSessionUrl,
  extractRealmRoles,
  mapRealmRolesToUserRole,
  registerOidcRoutes,
} from '../../src/auth/oidc.js';
import type { AppConfig } from '../../src/config.js';

/**
 * `client.discovery()` itself is mocked -- a real call would need a real IdP. `importOriginal`
 * keeps everything else from the real `openid-client` module.
 */
const discoveryMock = vi.fn();
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: (...args: unknown[]) => discoveryMock(...args),
  };
});

describe('extractRealmRoles()', () => {
  it('reads roles from a well-formed realm_access.roles claim', () => {
    expect(extractRealmRoles({ realm_access: { roles: ['admin', 'offline_access'] } })).toEqual([
      'admin',
      'offline_access',
    ]);
  });

  it('returns an empty array when realm_access is absent', () => {
    expect(extractRealmRoles({})).toEqual([]);
  });

  it('returns an empty array when realm_access.roles is absent', () => {
    expect(extractRealmRoles({ realm_access: {} })).toEqual([]);
  });

  it('returns an empty array when realm_access is not an object', () => {
    expect(extractRealmRoles({ realm_access: 'not-an-object' })).toEqual([]);
  });

  it('returns an empty array when realm_access.roles is not an array', () => {
    expect(extractRealmRoles({ realm_access: { roles: 'admin' } })).toEqual([]);
  });

  it('filters out non-string entries rather than throwing -- an untyped claims bag from the IdP', () => {
    expect(extractRealmRoles({ realm_access: { roles: ['admin', 42, null, 'viewer'] } })).toEqual([
      'admin',
      'viewer',
    ]);
  });
});

/**
 * canvas-mi9: highest-privilege realm role wins; no recognised role defaults to the
 * lowest-privilege 'viewer' rather than failing closed (no access) or open (silently admin).
 */
describe('mapRealmRolesToUserRole()', () => {
  it('maps a single recognised role directly', () => {
    expect(mapRealmRolesToUserRole(['admin'])).toBe('admin');
    expect(mapRealmRolesToUserRole(['architect'])).toBe('architect');
    expect(mapRealmRolesToUserRole(['viewer'])).toBe('viewer');
  });

  it('picks the highest-privilege role when a token carries more than one', () => {
    expect(mapRealmRolesToUserRole(['viewer', 'admin'])).toBe('admin');
    expect(mapRealmRolesToUserRole(['viewer', 'architect'])).toBe('architect');
    expect(mapRealmRolesToUserRole(['architect', 'admin'])).toBe('admin');
  });

  it('ignores unrecognised Keycloak built-in roles (e.g. offline_access) when picking', () => {
    expect(mapRealmRolesToUserRole(['offline_access', 'architect'])).toBe('architect');
  });

  it('defaults to viewer when no recognised role is present', () => {
    expect(mapRealmRolesToUserRole([])).toBe('viewer');
    expect(mapRealmRolesToUserRole(['offline_access', 'default-roles-canvasrealm'])).toBe('viewer');
  });
});

/**
 * canvas-252: pure URL builder for OIDC RP-Initiated Logout, extracted out of the
 * `app.buildOidcLogoutUrl` closure in `registerOidcRoutes` -- directly unit-testable, no
 * `client.discovery()`/Configuration mocking needed.
 */
describe('buildEndSessionUrl()', () => {
  it('sets client_id, id_token_hint, and post_logout_redirect_uri as query params', () => {
    const url = buildEndSessionUrl('https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout', {
      clientId: 'canvas-client',
      idTokenHint: 'the-id-token',
      postLogoutRedirectUri: 'https://app.example.com/',
    });

    expect(url.searchParams.get('client_id')).toBe('canvas-client');
    expect(url.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/');
  });

  it("preserves the end_session_endpoint's own origin and path, only adding query params", () => {
    const url = buildEndSessionUrl(
      'https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout',
      { clientId: 'canvas-client', idTokenHint: 'token', postLogoutRedirectUri: 'https://app.example.com/' },
    );

    expect(url.origin).toBe('https://keycloak.example.com');
    expect(url.pathname).toBe('/realms/CanvasRealm/protocol/openid-connect/logout');
  });

  it('accepts a URL instance as well as a string for endSessionEndpoint', () => {
    const url = buildEndSessionUrl(
      new URL('https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout'),
      { clientId: 'canvas-client', idTokenHint: 'token', postLogoutRedirectUri: 'https://app.example.com/' },
    );

    expect(url.origin).toBe('https://keycloak.example.com');
    expect(url.pathname).toBe('/realms/CanvasRealm/protocol/openid-connect/logout');
    expect(url.searchParams.get('client_id')).toBe('canvas-client');
  });

  it('URL-encodes values that contain characters needing encoding (e.g. a redirect URI with its own query string)', () => {
    const url = buildEndSessionUrl('https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout', {
      clientId: 'canvas-client',
      idTokenHint: 'token',
      postLogoutRedirectUri: 'https://app.example.com/?x=1&y=2',
    });

    // URLSearchParams.set percent-encodes the value it stores -- confirmed explicitly here rather
    // than assumed, per this file's own thorough style.
    expect(url.search).toContain('post_logout_redirect_uri=https%3A%2F%2Fapp.example.com%2F%3Fx%3D1%26y%3D2');
    // And .get() transparently decodes it back to the original, unmangled value.
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/?x=1&y=2');
  });
});

/**
 * canvas-252: `registerOidcRoutes` decorates `app.buildOidcLogoutUrl` only when the discovered
 * issuer metadata actually advertises an `end_session_endpoint` -- read defensively (optional
 * chaining + try/catch) since `oidcConfig.serverMetadata` may be absent entirely (a bare
 * `discoveryMock.mockResolvedValue({})`, as this describe block's own tests use below) or may
 * itself throw. Either way `session.ts`'s `/auth/logout` must fall back to local-session-only
 * logout exactly as it did before this feature existed.
 */
describe('registerOidcRoutes() buildOidcLogoutUrl decoration (canvas-252)', () => {
  function oidcConfig(overrides: Partial<AppConfig['oidc']> = {}): AppConfig {
    return {
      port: 3000,
      databaseUrl: 'unused',
      sessionSecret: 'unused-but-at-least-32-characters-long',
      oidc: {
        issuerUrl: 'https://public.example.com',
        clientId: 'canvas-client',
        clientSecret: 'secret',
        redirectUri: 'http://localhost:5173/callback',
        ...overrides,
      },
      allowLocalAuth: false,
      webOrigins: ['http://localhost:5173'],
      cookieSecure: false,
      cookieSameSite: 'lax',
      enableApiDocs: false,
    };
  }

  beforeEach(() => {
    discoveryMock.mockReset();
  });

  it('decorates buildOidcLogoutUrl when serverMetadata() advertises an end_session_endpoint', async () => {
    discoveryMock.mockResolvedValue({
      serverMetadata: () => ({
        end_session_endpoint: 'https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout',
      }),
    });

    const app = Fastify();
    await registerOidcRoutes(app, oidcConfig());
    await app.ready();

    expect(typeof app.buildOidcLogoutUrl).toBe('function');
    const logoutUrl = app.buildOidcLogoutUrl!('the-id-token');
    expect(logoutUrl).toContain('https://keycloak.example.com/realms/CanvasRealm/protocol/openid-connect/logout');
    const parsed = new URL(logoutUrl);
    expect(parsed.searchParams.get('client_id')).toBe('canvas-client');
    expect(parsed.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(parsed.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:5173');

    await app.close();
  });

  it('does not decorate buildOidcLogoutUrl when serverMetadata() returns no end_session_endpoint', async () => {
    discoveryMock.mockResolvedValue({ serverMetadata: () => ({}) });

    const app = Fastify();
    await registerOidcRoutes(app, oidcConfig());
    await app.ready();

    expect(app.buildOidcLogoutUrl).toBeUndefined();

    await app.close();
  });

  it('does not decorate buildOidcLogoutUrl, and does not throw, when serverMetadata is entirely absent', async () => {
    // The bare-{} shape every test in the sibling describe block above already relies on.
    discoveryMock.mockResolvedValue({});

    const app = Fastify();
    await expect(registerOidcRoutes(app, oidcConfig())).resolves.toBeUndefined();
    await expect(app.ready()).resolves.toBeDefined();

    expect(app.buildOidcLogoutUrl).toBeUndefined();

    await app.close();
  });

  it('does not decorate buildOidcLogoutUrl, and does not throw, when serverMetadata() itself throws', async () => {
    discoveryMock.mockResolvedValue({
      serverMetadata: () => {
        throw new Error('boom');
      },
    });

    const app = Fastify();
    await expect(registerOidcRoutes(app, oidcConfig())).resolves.toBeUndefined();
    await expect(app.ready()).resolves.toBeDefined();

    expect(app.buildOidcLogoutUrl).toBeUndefined();

    await app.close();
  });
});
