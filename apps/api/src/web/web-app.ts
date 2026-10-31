import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * canvas-r3y: the API serves the built web app from its own origin (WEB_DIST_DIR, set in the
 * container image). One origin means the session cookie is first-party (sign-in works with
 * third-party cookies blocked: Safari/iOS, private windows), no CORS preflight before each API
 * call, and one IP allow-list rule. Hashed /assets/* are cached for a year; everything else,
 * index.html included, is revalidated so a new deploy is picked up at once. Gzip/Brotli copies
 * made at build time (apps/web/scripts/precompress.mjs) are served when the browser accepts them.
 *
 * Only files that exist at start-up get routes (no wildcard), so nothing here can shadow an API
 * route, and an unknown path is still the API's ordinary 404.
 */
export async function registerWebApp(app: FastifyInstance, webDistDir: string | undefined): Promise<void> {
  if (!webDistDir || !existsSync(join(webDistDir, 'index.html'))) return;
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: '/',
    wildcard: false,
    index: ['index.html'],
    preCompressed: true,
    // Cache-Control is set per file below, not by the plugin's own maxAge default.
    cacheControl: false,
    // Paths are mapped to files on disk; a dotfile or anything outside root is never served.
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      const immutable = filePath.includes(`${join(webDistDir, 'assets')}`);
      res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}

/**
 * canvas-r3y: while the environment is paused (pause.sh sets CANVAS_PAUSED=true) the database is
 * stopped, so instead of failing every request the API answers with the "Canvas is paused" page
 * (browsers) or a 503 (API calls). /health still answers, so the platform keeps the app healthy.
 */
export function registerPausedMode(app: FastifyInstance, pausedPagePath: string | undefined): void {
  const page = pausedPagePath && existsSync(pausedPagePath) ? readFileSync(pausedPagePath, 'utf8') : '<!doctype html><title>Canvas is paused</title><p>Canvas is paused.</p>';
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    reply.header('Cache-Control', 'no-store').header('Retry-After', '3600');
    if (request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')) {
      return reply.code(503).type('text/html; charset=utf-8').send(page);
    }
    return reply.code(503).send({ error: 'Canvas is paused. Ask your admin to resume it.' });
  });
}
