import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closeTestDb } from '../helpers/setup.js';

/**
 * canvas-r3y: the API serves the built web app from its own origin, and shows the "paused" page
 * while the environment is paused.
 */
const dist = mkdtempSync(join(tmpdir(), 'canvas-web-'));
mkdirSync(join(dist, 'assets'));
const JS = 'console.log("canvas app");'.repeat(40);
writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div><script src="/assets/index-abc123.js"></script>');
writeFileSync(join(dist, 'assets', 'index-abc123.js'), JS);
writeFileSync(join(dist, 'assets', 'index-abc123.js.br'), brotliCompressSync(JS));
writeFileSync(join(dist, 'assets', 'index-abc123.js.gz'), gzipSync(JS));
writeFileSync(join(dist, 'license.txt'), 'MIT');
const pausedPage = join(dist, '..', `paused-${Date.now()}.html`);
writeFileSync(pausedPage, '<!doctype html><title>Canvas is paused</title><h1>Canvas is paused</h1>');

async function appWith(env: Record<string, string>): Promise<FastifyInstance> {
  process.env.NODE_ENV = 'test';
  const config = loadConfig({ ...process.env, ...env });
  return buildApp({ config, logger: false });
}

describe('serving the web app from the API origin', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await appWith({ WEB_DIST_DIR: dist });
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves index.html at / and always revalidates it', async () => {
    const res = await app.inject({ method: 'GET', url: '/?diagramId=whatever' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<div id="root">');
  });

  it('serves hashed assets compressed and cached for a year', async () => {
    const br = await app.inject({ method: 'GET', url: '/assets/index-abc123.js', headers: { 'accept-encoding': 'br, gzip' } });
    expect(br.statusCode).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(br.rawPayload.length).toBeLessThan(JS.length);
    const plain = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toBe(JS);
  });

  it('API routes and unknown paths behave exactly as before', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/projects' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/nothing-here.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/license.txt' })).body).toBe('MIT');
  });
});

describe('without a built web app (local dev, tests)', () => {
  it('serves no pages', async () => {
    const app = await appWith({ WEB_DIST_DIR: join(dist, 'missing') });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('paused', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await appWith({ WEB_DIST_DIR: dist, CANVAS_PAUSED: 'true', PAUSED_PAGE_PATH: pausedPage });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('shows the paused page to browsers, a 503 to API calls, and keeps /health up', async () => {
    const page = await app.inject({ method: 'GET', url: '/?projectId=x', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain('Canvas is paused');
    expect(page.headers['retry-after']).toBe('3600');
    const api = await app.inject({ method: 'GET', url: '/projects', headers: { accept: 'application/json' } });
    expect(api.statusCode).toBe(503);
    expect(api.json().error).toContain('paused');
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
