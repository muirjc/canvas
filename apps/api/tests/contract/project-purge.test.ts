import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';
import { getDb } from '../../src/db/client.js';
import { purgeExpiredDiagrams } from '../../src/diagrams/diagram.service.js';
import { findExpiredProjectIds, purgeExpiredProjects } from '../../src/projects/project.service.js';

/**
 * canvas-d3m: soft-deleted projects past PROJECT_RETENTION_DAYS were hidden and unrestorable, but
 * no code path ever physically deleted them -- jmuir-yvh's purge covered diagrams only. An expired
 * project is purged only once nothing references it (no diagrams in any state, no sub-projects);
 * anything still referenced is skipped and reported. Tested against the service functions, like
 * diagram-purge.test.ts: the purge is an ops-run script, not an HTTP route.
 */
describe('purgeExpiredProjects()', () => {
  let app: FastifyInstance;
  let ownerId: string;

  const DAY = 24 * 60 * 60 * 1000;

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
    ownerId = (await seedUser({ email: 'owner@example.com', password: 'owner-pass' })).id;
  });

  // Aged via Node's clock, matching the app-computed retention boundary (see diagram-purge.test.ts).
  async function softDeleteProject(id: string, ageDays: number): Promise<void> {
    await getDb().updateTable('projects').set({ deleted_at: new Date(Date.now() - ageDays * DAY), deleted_by_user_id: ownerId }).where('id', '=', id).execute();
  }

  async function seedChildProject(name: string, parentId: string): Promise<string> {
    const id = randomUUID();
    await getDb().insertInto('projects').values({ id, name, owner_id: ownerId, parent_project_id: parentId }).execute();
    return id;
  }

  async function seedDiagram(projectId: string, deletedAgeDays?: number): Promise<string> {
    const id = randomUUID();
    await getDb()
      .insertInto('diagrams')
      .values({
        id,
        name: 'D',
        diagram_type_id: 'flowchart',
        project_id: projectId,
        owner_id: ownerId,
        ...(deletedAgeDays === undefined ? {} : { deleted_at: new Date(Date.now() - deletedAgeDays * DAY), deleted_by_user_id: ownerId }),
      })
      .execute();
    return id;
  }

  const projectExists = async (id: string) =>
    (await getDb().selectFrom('projects').select('id').where('id', '=', id).execute()).length === 1;

  it('leaves active projects and projects still inside their retention window untouched', async () => {
    const active = (await seedProject('Active', ownerId)).id;
    const recent = (await seedProject('Recently deleted', ownerId)).id;
    await softDeleteProject(recent, 29);

    expect(await findExpiredProjectIds()).toEqual([]);
    const result = await purgeExpiredProjects();
    expect(result).toEqual({ purgedProjectIds: [], skipped: [] });
    expect(await projectExists(active)).toBe(true);
    expect(await projectExists(recent)).toBe(true);
  });

  it('physically deletes an empty expired project and its project-level share grants', async () => {
    const id = (await seedProject('Expired', ownerId)).id;
    await softDeleteProject(id, 31);
    const grantee = (await seedUser({ email: 'grantee@example.com', password: 'grantee-pass' })).id;
    await getDb()
      .insertInto('share_grants')
      .values({ id: randomUUID(), subject_type: 'project', subject_id: id, grantee_user_id: grantee, access_level: 'view', granted_by_user_id: ownerId })
      .execute();

    expect(await findExpiredProjectIds()).toEqual([id]);
    const result = await purgeExpiredProjects();

    expect(result).toEqual({ purgedProjectIds: [id], skipped: [] });
    expect(await projectExists(id)).toBe(false);
    expect(await getDb().selectFrom('share_grants').select('id').where('subject_id', '=', id).execute()).toHaveLength(0);
  });

  it('skips an expired project holding a soft-deleted diagram that is still restorable', async () => {
    const id = (await seedProject('Expired', ownerId)).id;
    const diagramId = await seedDiagram(id, 10);
    await softDeleteProject(id, 31);

    const result = await purgeExpiredProjects();

    expect(result).toEqual({ purgedProjectIds: [], skipped: [{ id, reason: 'still contains diagrams' }] });
    expect(await projectExists(id)).toBe(true);
    expect(await getDb().selectFrom('diagrams').select('id').where('id', '=', diagramId).execute()).toHaveLength(1);
  });

  it('purges the project once its expired diagrams are purged first (the purge script order)', async () => {
    const id = (await seedProject('Expired', ownerId)).id;
    await seedDiagram(id, 40);
    await softDeleteProject(id, 31);

    await purgeExpiredDiagrams();
    const result = await purgeExpiredProjects();

    expect(result.purgedProjectIds).toEqual([id]);
    expect(await projectExists(id)).toBe(false);
  });

  it('purges an expired child before its expired parent, in one call', async () => {
    const parent = (await seedProject('Parent', ownerId)).id;
    const child = await seedChildProject('Child', parent);
    await softDeleteProject(child, 35);
    await softDeleteProject(parent, 31);

    const result = await purgeExpiredProjects();

    expect(result.purgedProjectIds).toEqual([child, parent]);
    expect(result.skipped).toEqual([]);
    expect(await projectExists(parent)).toBe(false);
  });

  it('skips an expired parent whose sub-project is still live, and never cascades into it', async () => {
    const parent = (await seedProject('Parent', ownerId)).id;
    const child = await seedChildProject('Live child', parent);
    await softDeleteProject(parent, 31);

    const result = await purgeExpiredProjects();

    expect(result).toEqual({ purgedProjectIds: [], skipped: [{ id: parent, reason: 'still has sub-projects' }] });
    expect(await projectExists(parent)).toBe(true);
    expect(await projectExists(child)).toBe(true);
  });
});
