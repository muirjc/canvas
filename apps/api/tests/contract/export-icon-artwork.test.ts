import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { awsIconsManifest, serializeFlowchart } from '@canvas/diagram-core';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-8n7: renderToSvg's `resolveIcon` callback was never wired up anywhere in the real app —
 * `export.service.ts` called `renderToSvg(model)` with no resolver at all, so real SVG/PNG
 * exports never actually drew icon artwork, despite the renderer itself supporting it (only unit
 * tests exercised that path by passing a resolver manually). This is the export half of the fix;
 * the canvas half is covered by apps/web's own e2e suite (not runnable in this test file).
 */
describe('Diagram export: icon artwork (canvas-8n7)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  let sessionCookie: string;
  let projectId: string;

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    const project = await seedProject('Test Project', admin.id);
    projectId = project.id;

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'admin@example.com', password: 'admin-pass' },
    });
    const setCookie = loginResponse.headers['set-cookie'];
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];

    await app.inject({ method: 'POST', url: '/libraries', headers: { cookie: sessionCookie }, payload: awsIconsManifest });
  });

  it('renders the real icon artwork in an SVG export, not just the label text', async () => {
    const dsl = serializeFlowchart({
      diagramTypeId: 'flowchart',
      nodes: [
        {
          id: 'A',
          label: 'AWS Lambda',
          shape: 'icon',
          position: { x: 10, y: 10 },
          icon: { libraryId: 'aws-icons', libraryVersion: awsIconsManifest.version, iconId: 'lambda' },
        },
      ],
      edges: [],
      containers: [],
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Icon Export Test', diagramTypeId: 'flowchart', initialDslContent: dsl },
    });
    const { diagram } = createResponse.json();

    const exportResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=svg`,
      headers: { cookie: sessionCookie },
    });
    expect(exportResponse.statusCode).toBe(200);
    // #ec7211 is the Lambda placeholder icon's distinctive fill color (aws-icons.ts) — its
    // presence proves the real icon markup was drawn, not just the node's label text.
    expect(exportResponse.body).toContain('#ec7211');
    expect(exportResponse.body).toContain('AWS Lambda');
  });

  it('is a no-op (no crash, plain node) when the referenced icon does not exist', async () => {
    const dsl = serializeFlowchart({
      diagramTypeId: 'flowchart',
      nodes: [
        {
          id: 'A',
          label: 'Ghost',
          shape: 'icon',
          position: { x: 10, y: 10 },
          icon: { libraryId: 'aws-icons', libraryVersion: awsIconsManifest.version, iconId: 'does-not-exist' },
        },
      ],
      edges: [],
      containers: [],
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Missing Icon Export Test', diagramTypeId: 'flowchart', initialDslContent: dsl },
    });
    const { diagram } = createResponse.json();

    const exportResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=svg`,
      headers: { cookie: sessionCookie },
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.body).toContain('Ghost');
  });
});
