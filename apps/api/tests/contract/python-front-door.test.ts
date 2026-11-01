import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { closeTestDb } from '../helpers/setup.js';

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

  it('refuses a URL that is not http(s)', () => {
    expect(() => load({ PYTHON_API_URL: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => load({ PYTHON_API_URL: 'not a url' })).toThrow(/not a URL/);
  });
});
