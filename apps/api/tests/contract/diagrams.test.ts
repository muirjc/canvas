import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  closeTestDb,
  resetDatabase,
  seedFlowchartDiagramType,
  seedProject,
  seedUser,
} from '../helpers/setup.js';

/**
 * Contract for POST/GET/PATCH /diagrams and GET /diagrams/:id/export, per
 * specs/001-diagramming-platform/contracts/api-diagrams.md. Covers User Story 1's core loop.
 */
describe('Diagrams API contract', () => {
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
    const architect = await seedUser({ email: 'architect@example.com', password: 'correct horse battery staple' });
    // Owned by the acting user: projects became access-controlled in feature 007, so a
    // fixture project must name who works in it.
    const project = await seedProject('Test Project', architect.id);
    projectId = project.id;

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'architect@example.com', password: 'correct horse battery staple' },
    });
    expect(loginResponse.statusCode).toBe(200);
    const setCookie = loginResponse.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    sessionCookie = cookieHeader!.split(';')[0];
  });

  afterEach(async () => {
    // no-op: resetDatabase() at the start of each test is sufficient
  });

  it('rejects unauthenticated requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      payload: { name: 'Untitled', diagramTypeId: 'flowchart' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates, fetches, and saves a diagram end-to-end', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: {
        name: 'Smoke Test Diagram',
        diagramTypeId: 'flowchart',
        initialDslContent: 'flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n',
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const { diagram } = createResponse.json();
    expect(diagram.name).toBe('Smoke Test Diagram');
    expect(diagram.dslContent).toContain('A[Start]');

    const getResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}`,
      headers: { cookie: sessionCookie },
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().diagram.dslContent).toContain('A --> B');

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagram.id}`,
      headers: { cookie: sessionCookie },
      payload: { dslContent: 'flowchart TD\n  A[Start]\n  B[End]\n  C[New]\n  A --> B\n  B --> C\n' },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().diagram.dslContent).toContain('C[New]');
  });

  it('creates a diagram of a non-flowchart type with no explicit content using a family-appropriate default', async () => {
    // Regression test: creating a diagram used to always default to "flowchart TD\n" regardless
    // of diagram type, which fails to parse for any type whose DSL family isn't "flowchart".
    const pool = (await import('../../src/db/pool.js')).getPool();
    await pool.query(
      `INSERT INTO diagram_types (id, name, personas, abstraction_level, dsl_family, default_palette_library_ids)
       VALUES ('c4-context', 'C4 Context', ARRAY['Technical'], 'Context', 'c4', ARRAY['c4-notation'])`,
    );

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Untitled C4', diagramTypeId: 'c4-context' },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().diagram.dslContent).toContain('C4Context');
    expect(createResponse.json().diagram.dslFamily).toBe('c4');
  });

  it('rejects an unparseable DSL save with structured 422 details', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Bad Diagram', diagramTypeId: 'flowchart' },
    });
    const { diagram } = createResponse.json();

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagram.id}`,
      headers: { cookie: sessionCookie },
      payload: { dslContent: 'flowchart TD\n  ???not-valid???\n' },
    });
    expect(patchResponse.statusCode).toBe(422);
    const body = patchResponse.json();
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0]).toHaveProperty('line');
    expect(body.details[0]).toHaveProperty('message');
  });

  it('returns 404 for a non-existent diagram', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/diagrams/00000000-0000-0000-0000-000000000000',
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('exports a diagram as mermaid, svg, and png', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: sessionCookie },
      payload: {
        name: 'Export Test',
        diagramTypeId: 'flowchart',
        initialDslContent: 'flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n',
      },
    });
    const { diagram } = createResponse.json();

    const mermaidResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=mermaid`,
      headers: { cookie: sessionCookie },
    });
    expect(mermaidResponse.statusCode).toBe(200);
    expect(mermaidResponse.headers['content-type']).toContain('text/plain');
    expect(mermaidResponse.body).toContain('A[Start]');

    const svgResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=svg`,
      headers: { cookie: sessionCookie },
    });
    expect(svgResponse.statusCode).toBe(200);
    expect(svgResponse.headers['content-type']).toContain('image/svg+xml');
    expect(svgResponse.body).toContain('<svg');

    const pngResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=png`,
      headers: { cookie: sessionCookie },
    });
    expect(pngResponse.statusCode).toBe(200);
    expect(pngResponse.headers['content-type']).toContain('image/png');
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngBytes = pngResponse.rawPayload;
    expect(pngBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
