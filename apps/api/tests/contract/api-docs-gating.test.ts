import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closeTestDb, resetDatabase } from '../helpers/setup.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * canvas-docs: confirms app.ts's own enableApiDocs gate, through the real buildApp() (every real
 * route registered, not just api-docs.routes.ts in isolation -- api-docs.test.ts already covers
 * that unit) -- opt-in, same posture as allowLocalAuth: /docs must be completely absent (404, not
 * just unauthenticated) unless explicitly enabled, so a real deployment never exposes its full
 * route surface just because this repo added the capability.
 */
describe('/docs gating (enableApiDocs)', () => {
  async function buildAppWithConfig(overrides: Partial<ReturnType<typeof loadConfig>>): Promise<FastifyInstance> {
    process.env.NODE_ENV = 'test';
    const config = { ...loadConfig(), ...overrides };
    return buildApp({ config, logger: false });
  }

  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await resetDatabase();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('/docs is 404 when enableApiDocs is false (the default)', async () => {
    app = await buildAppWithConfig({ enableApiDocs: false });
    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(404);
  });

  it('/docs serves the real OpenAPI document, listing actual app routes, when enableApiDocs is true', async () => {
    app = await buildAppWithConfig({ enableApiDocs: true });
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const doc = response.json();
    // A handful of real, always-registered routes from different domains -- confirms this is the
    // actual app's route table, not just api-docs.routes.ts's own isolated plugin.
    expect(doc.paths).toHaveProperty('/health');
    expect(doc.paths).toHaveProperty('/auth/me');
    expect(doc.paths).toHaveProperty('/projects');
    expect(doc.paths).toHaveProperty('/projects/{projectId}/diagrams/import-template');
  });
});
