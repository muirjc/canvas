import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { closeTestDb } from '../helpers/setup.js';
import { PYTHON_ROUTE_GROUP_NAMES } from '../../src/python/route-groups.js';

/**
 * canvas-1bty.3: this service stays the front door while the backend moves to Python, forwarding the
 * route prefixes the Python service answers. Exercised against a stand-in upstream that echoes what it
 * received, so the test needs no Python.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe('forwarding moved routes to the Python service (canvas-1bty.3)', () => {
  let upstream: Server;
  let upstreamUrl = '';
  const seen: Seen[] = [];
  let app: FastifyInstance;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        if (req.url!.startsWith('/py/missing')) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['cid=rolled; Path=/; HttpOnly', 'other=1; Path=/'] });
        res.end(JSON.stringify({ service: 'python', path: req.url }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    process.env.NODE_ENV = 'test';
    await runMigrations();
    const config = { ...loadConfig({ ...process.env, NODE_ENV: 'test', PYTHON_API_URL: upstreamUrl, PYTHON_ROUTES: '/py' }), allowLocalAuth: true };
    app = await buildApp({ config, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await closeTestDb();
  });

  it('forwards the path, query and cookie, and passes every Set-Cookie back', async () => {
    const res = await app.inject({ method: 'GET', url: '/py/me?x=1&y=two', headers: { cookie: 'cid=abc.def%2Fg' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ service: 'python', path: '/py/me?x=1&y=two' });
    const last = seen.at(-1)!;
    expect(last.headers.cookie).toBe('cid=abc.def%2Fg');
    expect(last.headers['x-forwarded-proto']).toBe('http');
    // Python's cookies come back as they were. (This service's own session handling also runs on
    // forwarded routes: here it clears the made-up cid; with a real session both refresh the same value.)
    expect(res.headers['set-cookie']).toEqual(expect.arrayContaining(['cid=rolled; Path=/; HttpOnly', 'other=1; Path=/']));
  });

  it('forwards a JSON body byte for byte', async () => {
    const payload = '{"name":"Ünïcode","n":1}';
    const res = await app.inject({ method: 'POST', url: '/py/things', headers: { 'content-type': 'application/json' }, payload });
    expect(res.statusCode).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/py/things', body: payload });
  });

  it("passes the upstream's error status and body through", async () => {
    const res = await app.inject({ method: 'GET', url: '/py/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
  });

  it('only forwards the listed prefixes; this service still answers everything else', async () => {
    const before = seen.length;
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/pyx' })).statusCode).toBe(404);
    expect(seen.length).toBe(before);
  });
});

describe('forwarding moved routes by route pattern (canvas-1bty.6)', () => {
  let upstream: Server;
  const seen: Seen[] = [];
  let app: FastifyInstance;
  let fallbackApp: FastifyInstance;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'python', path: req.url }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    process.env.NODE_ENV = 'test';
    await runMigrations();
    const build = (groups?: string) =>
      buildApp({
        config: {
          ...loadConfig({ ...process.env, NODE_ENV: 'test', PYTHON_API_URL: url, ...(groups === undefined ? {} : { PYTHON_ROUTE_GROUPS: groups }) }),
          allowLocalAuth: true,
        },
        logger: false,
      });
    app = await build();
    fallbackApp = await build('libraries');
  });

  afterAll(async () => {
    await app.close();
    await fallbackApp.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('forwards a moved route with its parameters, query and body', async () => {
    const payload = '{"name":"Renamed"}';
    const res = await app.inject({ method: 'PATCH', url: '/projects/abc', headers: { 'content-type': 'application/json' }, payload });
    expect(res.json()).toEqual({ service: 'python', path: '/projects/abc' });
    expect(seen.at(-1)).toMatchObject({ method: 'PATCH', url: '/projects/abc', body: payload });
    // The audit log's client address, worked out here; one the client sends is overwritten.
    const spoofed = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'x-canvas-client-ip': '6.6.6.6' },
    });
    expect(spoofed.statusCode).toBe(200);
    expect(seen.at(-1)!.headers['x-canvas-client-ip']).toBe('203.0.113.9');
    expect((await app.inject({ method: 'GET', url: '/icons/search?diagramTypeId=x&query=y' })).json()).toEqual({
      service: 'python',
      path: '/icons/search?diagramTypeId=x&query=y',
    });
  });

  it('only forwards the moved method and pattern, not its neighbours', async () => {
    const before = seen.length;
    // Same prefix, routes not moved yet: TypeScript answers (401, no session).
    expect((await app.inject({ method: 'GET', url: '/projects/abc/diagrams' })).statusCode).toBe(401);
    // Local accounts stay on TypeScript (phase 9) while the rest of /admin/users moved.
    // (TypeScript checks this body before the role: 400 here means it answered, not Python.)
    expect((await app.inject({ method: 'POST', url: '/admin/users', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/users/abc/unlock' })).statusCode).toBe(401);
    // POST /libraries stays on TypeScript while GET /libraries moved.
    expect((await app.inject({ method: 'POST', url: '/libraries', payload: {} })).statusCode).toBe(401);
    expect(seen.length).toBe(before);
  });

  it('a group left out of PYTHON_ROUTE_GROUPS falls back to the TypeScript route', async () => {
    const before = seen.length;
    expect((await fallbackApp.inject({ method: 'GET', url: '/projects' })).statusCode).toBe(401);
    expect(seen.length).toBe(before);
    expect((await fallbackApp.inject({ method: 'GET', url: '/libraries' })).json()).toMatchObject({ service: 'python' });
  });
});

describe('Python routing settings (canvas-1bty.3)', () => {
  const load = (env: Record<string, string>) => loadConfig({ ...process.env, NODE_ENV: 'test', ...env });

  it('is off without PYTHON_API_URL', () => {
    expect(load({ PYTHON_API_URL: '' })).toMatchObject({ pythonRoutePrefixes: [] });
    expect(load({ PYTHON_API_URL: '' }).pythonApiUrl).toBeUndefined();
  });

  it('defaults to /py and accepts a comma-separated list', () => {
    expect(load({ PYTHON_API_URL: 'http://canvas-api-py/' })).toMatchObject({ pythonApiUrl: 'http://canvas-api-py', pythonRoutePrefixes: ['/py'] });
    expect(load({ PYTHON_API_URL: 'http://x', PYTHON_ROUTES: ' /py, /diagram-types/ ,/a/b-c' }).pythonRoutePrefixes).toEqual(['/py', '/diagram-types', '/a/b-c']);
  });

  it.each(['/', 'py', '/py/*', '/../x', '/Py'])('refuses the prefix %s', (prefix) => {
    expect(() => load({ PYTHON_API_URL: 'http://x', PYTHON_ROUTES: prefix })).toThrow(/PYTHON_ROUTES/);
  });

  it('forwards every moved route group by default, none with "none", or the listed ones (canvas-1bty.6)', () => {
    expect(load({ PYTHON_API_URL: 'http://x' }).pythonRouteGroups).toEqual(PYTHON_ROUTE_GROUP_NAMES);
    expect(load({ PYTHON_API_URL: 'http://x', PYTHON_ROUTE_GROUPS: 'none' }).pythonRouteGroups).toEqual([]);
    expect(load({ PYTHON_API_URL: 'http://x', PYTHON_ROUTE_GROUPS: ' projects , libraries' }).pythonRouteGroups).toEqual(['projects', 'libraries']);
    expect(load({ PYTHON_API_URL: '', PYTHON_ROUTE_GROUPS: 'projects' }).pythonRouteGroups).toEqual([]);
    expect(() => load({ PYTHON_API_URL: 'http://x', PYTHON_ROUTE_GROUPS: 'everything' })).toThrow(/PYTHON_ROUTE_GROUPS/);
  });

  it('refuses a URL that is not http(s)', () => {
    expect(() => load({ PYTHON_API_URL: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => load({ PYTHON_API_URL: 'not a url' })).toThrow(/not a URL/);
  });
});
