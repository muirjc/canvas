import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-1bty.18: creating or importing a diagram into a project that doesn't exist answered 500 (the
 * diagrams.project_id foreign key), and a soft-deleted project would have taken the diagram. Both are
 * a 404 now, like every other route that names a missing project.
 */
describe('diagrams in a missing or deleted project (canvas-1bty.18)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let deletedProjectId: string;
  const missing = '00000000-0000-0000-0000-000000000000';

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const admin = await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    deletedProjectId = (await seedProject('Gone', admin.id)).id;
    await getDb().updateTable('projects').set({ deleted_at: new Date() }).where('id', '=', deletedProjectId).execute();
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'admin@example.com', password: 'admin-pass' } });
    const header = login.headers['set-cookie'];
    cookie = (Array.isArray(header) ? header[0] : header)!.split(';')[0];
  });

  const requests = (projectId: string) => [
    { url: `/projects/${projectId}/diagrams`, payload: { name: 'D', diagramTypeId: 'flowchart' } },
    { url: `/projects/${projectId}/diagrams/import`, payload: { name: 'D', dslContent: 'flowchart TD\n  A --> B\n' } },
    { url: `/projects/${projectId}/diagrams/import-template`, payload: { name: 'D', diagramTypeId: 'c4-context', templateContent: '# x' } },
  ];

  it.each([
    ['missing', () => missing],
    ['soft-deleted', () => deletedProjectId],
  ])('a %s project is 404 and nothing is created', async (_label, projectId) => {
    for (const { url, payload } of requests(projectId())) {
      const response = await app.inject({ method: 'POST', url, headers: { cookie }, payload });
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ error: `No project with id ${projectId()}` });
    }
    expect(await getDb().selectFrom('diagrams').select('id').execute()).toEqual([]);
  });
});
