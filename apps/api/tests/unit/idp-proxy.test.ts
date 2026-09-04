import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIdpProxyRoutes } from '../../src/auth/idp-proxy.routes.js';
import type { AppConfig } from '../../src/config.js';

/**
 * Unit coverage for canvas-ycu.1's /idp/* reverse proxy (idp-proxy.routes.ts). No real Keycloak
 * or database involved -- a bare Fastify instance with only this one plugin registered
 * (`buildTestApp()` needs a real Postgres connection this proxy has nothing to do with), and
 * `global.fetch` mocked to stand in for the internal Keycloak the proxy would otherwise call.
 */

function baseConfig(overrides: Partial<AppConfig['oidc']> = {}): AppConfig {
  return {
    port: 3000,
    databaseUrl: 'unused',
    sessionSecret: 'unused-but-at-least-32-characters-long',
    oidc: {
      keycloakInternalUrl: 'https://keycloak.internal.example.com',
      ...overrides,
    },
    allowLocalAuth: false,
    webOrigins: ['http://localhost:5173'],
    cookieSecure: false,
    cookieSameSite: 'lax',
  };
}

let app: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;
let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof global.fetch;
});

afterEach(async () => {
  global.fetch = originalFetch;
  if (app) await app.close();
});

describe('registerIdpProxyRoutes() no-op behavior', () => {
  it('registers nothing when keycloakInternalUrl is unset -- /idp/* 404s', async () => {
    app = Fastify();
    await registerIdpProxyRoutes(app, baseConfig({ keycloakInternalUrl: undefined }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/idp/anything' });
    expect(response.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('registerIdpProxyRoutes() proxying', () => {
  beforeEach(async () => {
    app = Fastify();
    await registerIdpProxyRoutes(app, baseConfig());
    await app.ready();
  });

  it('proxies a GET request to the correct internal URL and passes through status/body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issuer: 'https://public.example.com/idp/realms/CanvasRealm' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/idp/realms/CanvasRealm/.well-known/openid-configuration',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe(
      'https://keycloak.internal.example.com/idp/realms/CanvasRealm/.well-known/openid-configuration',
    );
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      issuer: 'https://public.example.com/idp/realms/CanvasRealm',
    });
  });

  it('preserves the query string when building the target URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await app.inject({ method: 'GET', url: '/idp/realms/CanvasRealm/protocol/openid-connect/auth?client_id=canvas&state=abc' });

    const [target] = fetchMock.mock.calls[0];
    expect(target).toBe(
      'https://keycloak.internal.example.com/idp/realms/CanvasRealm/protocol/openid-connect/auth?client_id=canvas&state=abc',
    );
  });

  it('proxies a POST with an application/x-www-form-urlencoded body intact', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'xyz' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const formBody = 'grant_type=password&username=alice&password=hunter2';
    const response = await app.inject({
      method: 'POST',
      url: '/idp/realms/CanvasRealm/protocol/openid-connect/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe('https://keycloak.internal.example.com/idp/realms/CanvasRealm/protocol/openid-connect/token');
    expect(init.method).toBe('POST');
    // The raw-buffer content-type parser forwards bytes as-is, not a re-serialized body.
    expect(Buffer.from(init.body).toString('utf8')).toBe(formBody);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ access_token: 'xyz' });
  });

  it('proxies a PUT with an application/json body byte-for-byte, not re-serialized (real bug found live)', async () => {
    // Found via a real deployed environment: Fastify's own built-in application/json content-type
    // parser always takes precedence over a '*' wildcard parser regardless of registration order
    // (confirmed against Fastify's own docs, not guessed) -- so without removeAllContentTypeParsers()
    // first, a JSON-bodied request reaching this proxy was parsed into a JS object by that default
    // parser, then handed to fetch()'s `body` option as that object, which stringifies to the
    // literal text "[object Object]" -- Keycloak's admin API (every write is JSON: PUT a client,
    // POST a new one, ...) rejected every single one with a generic "Cannot parse the JSON" error.
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const jsonBody = JSON.stringify({ redirectUris: ['https://example.com/auth/callback'], secret: 'sh+are/me=' });
    const response = await app.inject({
      method: 'PUT',
      url: '/idp/admin/realms/CanvasRealm/clients/abc-123',
      headers: { 'content-type': 'application/json' },
      payload: jsonBody,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PUT');
    // The forwarded body must be the exact original bytes -- not "[object Object]", not
    // re-serialized/reformatted JSON that could reorder keys or otherwise diverge byte-for-byte.
    expect(Buffer.from(init.body).toString('utf8')).toBe(jsonBody);
    expect(response.statusCode).toBe(200);
  });

  it('does not attach a body to GET/HEAD forwarded requests', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await app.inject({ method: 'GET', url: '/idp/realms/CanvasRealm/.well-known/openid-configuration' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it('strips hop-by-hop headers from the forwarded request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await app.inject({
      method: 'GET',
      url: '/idp/realms/CanvasRealm/.well-known/openid-configuration',
      headers: {
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'x-custom-header': 'keep-me',
      },
    });

    const [, init] = fetchMock.mock.calls[0];
    const forwardedKeys = Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase());
    expect(forwardedKeys).not.toContain('connection');
    expect(forwardedKeys).not.toContain('keep-alive');
    expect(forwardedKeys).not.toContain('host');
    expect((init.headers as Record<string, string>)['x-custom-header']).toBe('keep-me');
  });

  it('strips hop-by-hop headers from the proxied response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('ok', {
        status: 200,
        headers: {
          'content-encoding': 'gzip',
          'transfer-encoding': 'chunked',
          'x-response-header': 'keep-me',
        },
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/idp/realms/CanvasRealm/.well-known/openid-configuration',
    });

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['transfer-encoding']).toBeUndefined();
    expect(response.headers['x-response-header']).toBe('keep-me');
  });

  it('passes an upstream 3xx redirect through to the client unmodified', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://public.example.com/idp/realms/CanvasRealm/login-actions/authenticate' },
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/idp/realms/CanvasRealm/protocol/openid-connect/auth',
    });

    // redirect: 'manual' on the outgoing fetch call means the proxy itself never follows it.
    const [, init] = fetchMock.mock.calls[0];
    expect(init.redirect).toBe('manual');

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'https://public.example.com/idp/realms/CanvasRealm/login-actions/authenticate',
    );
  });
});
