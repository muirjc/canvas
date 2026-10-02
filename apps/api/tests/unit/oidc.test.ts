import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEndSessionUrl,
  extractEntraRoles,
  extractIdentityFromIdToken,
  mapIdpRolesToUserRole,
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

describe('extractEntraRoles()', () => {
  it('reads roles from a well-formed flat roles claim', () => {
    expect(extractEntraRoles({ roles: ['admin', 'SomeOtherAppRole'] })).toEqual(['admin', 'SomeOtherAppRole']);
  });

  it('returns an empty array when roles is absent', () => {
    expect(extractEntraRoles({})).toEqual([]);
  });

  it('returns an empty array when roles is not an array', () => {
    expect(extractEntraRoles({ roles: 'admin' })).toEqual([]);
  });

  it('filters out non-string entries rather than throwing -- an untyped claims bag from the IdP', () => {
    expect(extractEntraRoles({ roles: ['admin', 42, null, 'viewer'] })).toEqual(['admin', 'viewer']);
  });

  it('does NOT read a Keycloak-shaped nested realm_access.roles claim -- that was the previous IdP, not Entra', () => {
    expect(extractEntraRoles({ realm_access: { roles: ['admin'] } })).toEqual([]);
  });
});

/**
 * canvas-mi9: highest-privilege role wins; no recognised role defaults to the lowest-privilege
 * 'viewer' rather than failing closed (no access) or open (silently admin).
 */
describe('mapIdpRolesToUserRole()', () => {
  it('maps a single recognised role directly', () => {
    expect(mapIdpRolesToUserRole(['admin'])).toBe('admin');
    expect(mapIdpRolesToUserRole(['architect'])).toBe('architect');
    expect(mapIdpRolesToUserRole(['viewer'])).toBe('viewer');
  });

  it('picks the highest-privilege role when a token carries more than one', () => {
    expect(mapIdpRolesToUserRole(['viewer', 'admin'])).toBe('admin');
    expect(mapIdpRolesToUserRole(['viewer', 'architect'])).toBe('architect');
    expect(mapIdpRolesToUserRole(['architect', 'admin'])).toBe('admin');
  });

  it('ignores unrecognised app roles when picking', () => {
    expect(mapIdpRolesToUserRole(['SomeOtherAppRole', 'architect'])).toBe('architect');
  });

  it('defaults to viewer when no recognised role is present', () => {
    expect(mapIdpRolesToUserRole([])).toBe('viewer');
    expect(mapIdpRolesToUserRole(['SomeOtherAppRole'])).toBe('viewer');
  });
});

describe('extractIdentityFromIdToken()', () => {
  it('reads sub, email, and name directly off the ID token claims', () => {
    expect(extractIdentityFromIdToken({ sub: 'abc123', email: 'jane@example.com', name: 'Jane Doe' })).toEqual({
      sub: 'abc123',
      email: 'jane@example.com',
      name: 'Jane Doe',
    });
  });

  it('lowercases the email claim -- Entra can return it in whatever case the directory stores it', () => {
    expect(extractIdentityFromIdToken({ sub: 'abc123', email: 'Jane.Doe@Contoso.com' }).email).toBe(
      'jane.doe@contoso.com',
    );
  });

  it('falls back to preferred_username when email is absent and preferred_username looks like an email', () => {
    expect(extractIdentityFromIdToken({ sub: 'abc123', preferred_username: 'Jane@Contoso.com' }).email).toBe(
      'jane@contoso.com',
    );
  });

  it('does not use preferred_username as email when it does not contain "@" -- Entra documents it as a mutable UPN, not guaranteed to look like an email', () => {
    expect(extractIdentityFromIdToken({ sub: 'abc123', preferred_username: 'not-an-email' }).email).toBeUndefined();
  });

  it('prefers the real email claim over preferred_username when both are present', () => {
    expect(
      extractIdentityFromIdToken({ sub: 'abc123', email: 'real@example.com', preferred_username: 'upn@example.com' })
        .email,
    ).toBe('real@example.com');
  });

  it('returns undefined email and name when neither claim nor fallback is present', () => {
    expect(extractIdentityFromIdToken({ sub: 'abc123' })).toEqual({ sub: 'abc123', email: undefined, name: undefined });
  });

  it('returns an empty string sub when the claim is missing or not a string -- callers must still check it', () => {
    expect(extractIdentityFromIdToken({}).sub).toBe('');
    expect(extractIdentityFromIdToken({ sub: 42 }).sub).toBe('');
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
