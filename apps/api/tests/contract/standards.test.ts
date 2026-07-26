import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  closeTestDb,
  resetDatabase,
  seedFlowchartDiagramType,
  seedProject,
  seedUser,
} from '../helpers/setup.js';

/**
 * Contract for Standard create/publish/retire lifecycle, per
 * specs/001-diagramming-platform/contracts/api-standards-libraries.md. Covers User Story 2.
 */
describe('Standards API contract', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    return cookieHeader!.split(';')[0];
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' });
    adminCookie = await login('admin@example.com', 'admin-pass');
    architectCookie = await login('architect@example.com', 'architect-pass');
  });

  it('rejects standard creation from a non-admin user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/diagram-types/flowchart/standards',
      headers: { cookie: architectCookie },
      payload: { allowedShapeIds: ['rectangle'] },
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 for a diagram type with no published standard yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/diagram-types/flowchart/standard',
      headers: { cookie: architectCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it('creates a draft, publishes it, and it becomes the active standard', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/diagram-types/flowchart/standards',
      headers: { cookie: adminCookie },
      payload: { allowedShapeIds: ['rectangle', 'circle'], colorPalette: [{ role: 'system', colorHex: '#1168bd' }] },
    });
    expect(createResponse.statusCode).toBe(201);
    const { standard } = createResponse.json();
    expect(standard.status).toBe('draft');

    const publishResponse = await app.inject({
      method: 'POST',
      url: `/standards/${standard.id}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(publishResponse.statusCode).toBe(200);
    expect(publishResponse.json().standard.status).toBe('published');

    const activeResponse = await app.inject({
      method: 'GET',
      url: '/diagram-types/flowchart/standard',
      headers: { cookie: architectCookie },
    });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json().standard.id).toBe(standard.id);
  });

  it('publishing a new standard retires the previously published one (only one active at a time)', async () => {
    const first = (
      await app.inject({
        method: 'POST',
        url: '/diagram-types/flowchart/standards',
        headers: { cookie: adminCookie },
        payload: { allowedShapeIds: ['rectangle'] },
      })
    ).json().standard;
    await app.inject({ method: 'POST', url: `/standards/${first.id}/publish`, headers: { cookie: adminCookie } });

    const second = (
      await app.inject({
        method: 'POST',
        url: '/diagram-types/flowchart/standards',
        headers: { cookie: adminCookie },
        payload: { allowedShapeIds: ['circle'] },
      })
    ).json().standard;
    const secondPublish = await app.inject({
      method: 'POST',
      url: `/standards/${second.id}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(secondPublish.statusCode).toBe(200);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/diagram-types/flowchart/standards',
      headers: { cookie: adminCookie },
    });
    const standards = listResponse.json().standards;
    const firstAfter = standards.find((s: { id: string }) => s.id === first.id);
    const secondAfter = standards.find((s: { id: string }) => s.id === second.id);
    expect(firstAfter.status).toBe('retired');
    expect(secondAfter.status).toBe('published');
  });

  it('retires a standard on demand', async () => {
    const draft = (
      await app.inject({
        method: 'POST',
        url: '/diagram-types/flowchart/standards',
        headers: { cookie: adminCookie },
        payload: {},
      })
    ).json().standard;
    await app.inject({ method: 'POST', url: `/standards/${draft.id}/publish`, headers: { cookie: adminCookie } });

    const retireResponse = await app.inject({
      method: 'POST',
      url: `/standards/${draft.id}/retire`,
      headers: { cookie: adminCookie },
    });
    expect(retireResponse.statusCode).toBe(200);
    expect(retireResponse.json().standard.status).toBe('retired');

    const activeResponse = await app.inject({
      method: 'GET',
      url: '/diagram-types/flowchart/standard',
      headers: { cookie: architectCookie },
    });
    expect(activeResponse.statusCode).toBe(404);
  });

  it('soft-flags a diagram that violates the active standard without blocking the save (FR-024)', async () => {
    const draft = (
      await app.inject({
        method: 'POST',
        url: '/diagram-types/flowchart/standards',
        headers: { cookie: adminCookie },
        payload: { allowedShapeIds: ['rectangle'] },
      })
    ).json().standard;
    await app.inject({ method: 'POST', url: `/standards/${draft.id}/publish`, headers: { cookie: adminCookie } });

    // Project creation is User Story 4's concern; seed one directly here so this test only
    // exercises User Story 1 + 2 behavior.
    const project = await seedProject();

    const createResponse = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/diagrams`,
      headers: { cookie: architectCookie },
      payload: {
        name: 'Violating Diagram',
        diagramTypeId: 'flowchart',
        initialDslContent: 'flowchart TD\n  A((Circle Not Allowed))\n',
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const { diagram } = createResponse.json();
    expect(diagram.lastValidationResult).toContainEqual(
      expect.objectContaining({ elementId: 'A', rule: 'allowed-shapes' }),
    );

    // Save still succeeded (201 above) — a violation never blocks save/export.
    const exportResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=svg`,
      headers: { cookie: architectCookie },
    });
    expect(exportResponse.statusCode).toBe(200);
  });
});
