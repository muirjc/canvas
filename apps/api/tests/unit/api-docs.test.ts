import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerApiDocsRoutes } from '../../src/docs/api-docs.routes.js';

/**
 * Unit coverage for canvas-docs' OpenAPI/Swagger wiring (api-docs.routes.ts). A bare Fastify
 * instance with only this one plugin registered -- same minimal pattern as idp-proxy.test.ts/
 * oidc.test.ts -- since neither @fastify/swagger nor @fastify/swagger-ui touch the database at
 * all, unlike the app.ts-level `enableApiDocs` gate this file deliberately does NOT re-test (that
 * belongs to config.test.ts's own `loadConfig() enableApiDocs` coverage; this file only tests
 * what registerApiDocsRoutes itself does once app.ts has decided to call it).
 */
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe('registerApiDocsRoutes()', () => {
  it('serves the Swagger UI at /docs', async () => {
    app = Fastify();
    await registerApiDocsRoutes(app);
    app.get('/health', async () => ({ status: 'ok' }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(200);
  });

  it('serves a valid OpenAPI document at /docs/json listing every registered route', async () => {
    app = Fastify();
    await registerApiDocsRoutes(app);
    app.get('/health', async () => ({ status: 'ok' }));
    app.post('/widgets', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const doc = response.json();
    expect(doc.info.title).toBe('Canvas API');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/health', '/widgets']));
    expect(doc.paths['/widgets']).toHaveProperty('post');
  });

  it('declares a cookieAuth security scheme naming the real session cookie', async () => {
    app = Fastify();
    await registerApiDocsRoutes(app);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    const doc = response.json();
    // @fastify/session's own default cookie name (options.cookieName || 'sessionId',
    // node_modules/@fastify/session/index.js) -- session.ts never overrides it.
    expect(doc.components.securitySchemes.cookieAuth).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'sessionId',
    });
  });

  it('registered before a route means that route IS documented (registration-order requirement)', async () => {
    app = Fastify();
    await registerApiDocsRoutes(app);
    app.get('/registered-after', async () => ({ ok: true }));
    await app.ready();

    const doc = (await app.inject({ method: 'GET', url: '/docs/json' })).json();
    expect(doc.paths).toHaveProperty('/registered-after');
  });
});
