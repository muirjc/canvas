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
 * Contract for GET /shared-diagrams (feature 008, FR-001/FR-002/FR-004/FR-005/FR-006/FR-007/
 * FR-011). Self-scoped like GET /projects — no parameter names a user or diagram, the session
 * does.
 *
 * The endpoint deliberately does no access-resolution work of its own (research.md §1): it is one
 * join over share_grants, and several of the trickiest-looking requirements — no duplication
 * check needed, revoked/deleted grants simply absent — fall out of that join's shape rather than
 * from extra code. These tests exist to prove that shape is actually correct, not to re-derive
 * resolveDiagramAccess.
 */
describe('Shared diagrams API contract', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let ownerCookie: string;
  let granteeId: string;
  let granteeCookie: string;

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  async function createDiagram(cookie: string, projectId: string, name: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie },
      payload: { name, diagramTypeId: 'flowchart', initialDslContent: 'flowchart TD\n  A[Start]\n' },
    });
    return response.json().diagram.id;
  }

  async function shareDiagram(
    cookie: string,
    diagramId: string,
    granteeUserId: string,
    accessLevel: 'view' | 'comment' | 'edit',
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/shares`,
      headers: { cookie },
      payload: { granteeUserId, accessLevel },
    });
    return response.json().grant.id;
  }

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
    ({ id: ownerId } = await seedUser({ email: 'owner@example.com', password: 'owner-pass' }));
    ({ id: granteeId } = await seedUser({ email: 'grantee@example.com', password: 'grantee-pass' }));
    ownerCookie = await login('owner@example.com', 'owner-pass');
    granteeCookie = await login('grantee@example.com', 'grantee-pass');
  });

  it('shows a diagram shared directly with a user who has no project access at all', async () => {
    const projectId = (await seedProject('Confidential Merger', ownerId)).id;
    const diagramId = await createDiagram(ownerCookie, projectId, 'Payment Flow');
    await shareDiagram(ownerCookie, diagramId, granteeId, 'view');

    const response = await app.inject({ method: 'GET', url: '/shared-diagrams', headers: { cookie: granteeCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().diagrams).toHaveLength(1);
    const entry = response.json().diagrams[0];
    expect(entry.diagramId).toBe(diagramId);
    expect(entry.diagramName).toBe('Payment Flow');
    expect(entry.accessLevel).toBe('view');
    expect(entry.projectName).toBe('Confidential Merger');
    expect(entry.sharedByName).toBeTruthy();
  });

  it('includes a diagram even when the user also has project-level access to it (no de-duplication check)', async () => {
    const projectId = (await seedProject('Shared Project', ownerId)).id;
    const diagramId = await createDiagram(ownerCookie, projectId, 'In-Project Diagram');
    // Grantee gets BOTH a project-level grant and a diagram-level grant on the same diagram.
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/shares`,
      headers: { cookie: ownerCookie },
      payload: { granteeUserId: granteeId, accessLevel: 'view' },
    });
    await shareDiagram(ownerCookie, diagramId, granteeId, 'edit');

    const response = await app.inject({ method: 'GET', url: '/shared-diagrams', headers: { cookie: granteeCookie } });
    expect(response.json().diagrams).toHaveLength(1);
    expect(response.json().diagrams[0].accessLevel).toBe('edit');
  });

  it('stops naming a diagram once its grant is revoked', async () => {
    const projectId = (await seedProject('Some Project', ownerId)).id;
    const diagramId = await createDiagram(ownerCookie, projectId, 'Temporary Share');
    const grantId = await shareDiagram(ownerCookie, diagramId, granteeId, 'view');

    await app.inject({ method: 'DELETE', url: `/shares/${grantId}`, headers: { cookie: ownerCookie } });

    const response = await app.inject({ method: 'GET', url: '/shared-diagrams', headers: { cookie: granteeCookie } });
    expect(response.json().diagrams).toEqual([]);
  });

  it('stops naming a diagram once it is soft-deleted', async () => {
    const projectId = (await seedProject('Another Project', ownerId)).id;
    const diagramId = await createDiagram(ownerCookie, projectId, 'Soon Deleted');
    await shareDiagram(ownerCookie, diagramId, granteeId, 'view');

    await app.inject({ method: 'DELETE', url: `/diagrams/${diagramId}`, headers: { cookie: ownerCookie } });

    const response = await app.inject({ method: 'GET', url: '/shared-diagrams', headers: { cookie: granteeCookie } });
    expect(response.json().diagrams).toEqual([]);
  });

  it('never includes a field naming an ancestor project — only the immediate one', async () => {
    const parentId = (await seedProject('Parent Project', ownerId)).id;
    const childResponse = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { cookie: ownerCookie },
      payload: { name: 'Child Project', parentProjectId: parentId },
    });
    const childId = childResponse.json().project.id;
    const diagramId = await createDiagram(ownerCookie, childId, 'Nested Diagram');
    await shareDiagram(ownerCookie, diagramId, granteeId, 'view');

    const response = await app.inject({ method: 'GET', url: '/shared-diagrams', headers: { cookie: granteeCookie } });
    const entry = response.json().diagrams[0];
    expect(entry.projectName).toBe('Child Project');
    expect(response.body).not.toContain('Parent Project');
  });

  it('returns an empty list — not an error — for a user with nothing shared', async () => {
    const response = await app.inject({ method: 'GET', url: '/shared-diagrams', headers: { cookie: granteeCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().diagrams).toEqual([]);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/shared-diagrams' });
    expect(response.statusCode).toBe(401);
  });
});
