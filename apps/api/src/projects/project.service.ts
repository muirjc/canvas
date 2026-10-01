import { sql } from 'kysely';
import { getPool } from '../db/pool.js';
import { getDb } from '../db/client.js';
import { ACCESSIBLE_PROJECT_IDS_SQL } from './project.access.js';

export class ProjectNotFoundError extends Error {}
export class ProjectCycleError extends Error {}
export class ProjectHasContentError extends Error {}
export class ProjectRetentionExpiredError extends Error {}

/** Soft-deleted projects older than this are no longer restorable (canvas-228.2), mirroring
 *  DIAGRAM_RETENTION_DAYS in diagram.service.ts — same policy, separate constant because it's a
 *  different table's rule, not because the value should ever differ. */
export const PROJECT_RETENTION_DAYS = 30;

/** App-computed retention boundary (canvas-jtm.4) — replaces `now() - make_interval(days => $n)`,
 *  a Postgres-specific function with no SQLite equivalent. Mirrors diagram.service.ts's own
 *  retentionBoundary() — a separate copy because it uses a different constant, not because the
 *  logic should ever diverge. */
function retentionBoundary(): Date {
  return new Date(Date.now() - PROJECT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export interface ProjectRecord {
  id: string;
  name: string;
  parentProjectId: string | null;
  createdAt: string;
}

export interface ProjectListItem extends ProjectRecord {
  /** Direct (non-recursive) count of the project's own non-deleted diagrams — canvas-228.1's
   *  Projects screen shows this per row, and canvas-228.2's delete guard rejects unless it's 0. */
  diagramCount: number;
  /** Who owns this project — canvas-228.3's Projects screen only offers rename/delete for
   *  projects the current user owns (or if they're an admin). */
  ownerId: string;
}

export interface CreateProjectInput {
  name: string;
  parentProjectId?: string;
  /** The creating user, who becomes the project's owner (feature 007, FR-013c). */
  ownerId: string;
}

/**
 * Creates a Project/Folder (FR-016). Projects are only ever attached to a parent at creation
 * time (there is no re-parenting endpoint), so a brand-new row can never be its own ancestor —
 * cycle prevention here means rejecting a parentProjectId that doesn't exist, which is the only
 * way a cycle could otherwise be introduced later.
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectListItem> {
  const db = getDb();
  if (input.parentProjectId) {
    const parent = await db.selectFrom('projects').select('id').where('id', '=', input.parentProjectId).executeTakeFirst();
    if (!parent) {
      throw new ProjectCycleError(`Parent project ${input.parentProjectId} does not exist`);
    }
  }
  const row = await db
    .insertInto('projects')
    .values({ name: input.name, parent_project_id: input.parentProjectId ?? null, owner_id: input.ownerId })
    .returning(['id', 'name', 'parent_project_id', 'created_at'])
    .executeTakeFirstOrThrow();
  // Always 0 — a brand-new project cannot already have a diagram in it. ownerId is already known
  // (it's the input, not read back) — no need to re-query for it.
  return {
    id: row.id,
    name: row.name,
    parentProjectId: row.parent_project_id,
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    createdAt: row.created_at as unknown as string,
    diagramCount: 0,
    ownerId: input.ownerId,
  };
}

/**
 * The projects available to a user — owned or shared, plus their descendants (feature 007,
 * FR-013a). Delegates the rule to `project.access.ts` so the list and the route guard cannot
 * disagree; a disagreement between them is a data leak, not a display bug.
 *
 * Ordered by name so the chooser is stable between loads. No search or paging: the clarified
 * scale is tens of projects (FR-013e).
 *
 * Deliberately NOT converted to Kysely (canvas-jtm.4 scope: this function is built directly on
 * `ACCESSIBLE_PROJECT_IDS_SQL`'s `WITH RECURSIVE` fragment — recursive-CTE conversion is
 * canvas-jtm.5's own dedicated, authorization-critical-risk phase, not bundled in here).
 */
export async function listProjectsForUser(userId: string): Promise<ProjectListItem[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    name: string;
    parent_project_id: string | null;
    created_at: string;
    owner_id: string;
    diagram_count: string;
  }>(
    `${ACCESSIBLE_PROJECT_IDS_SQL}
     SELECT p.id, p.name, p.parent_project_id, p.created_at, p.owner_id, COUNT(d.id) AS diagram_count
     FROM projects p
     LEFT JOIN diagrams d ON d.project_id = p.id AND d.deleted_at IS NULL
     WHERE p.id IN (SELECT id FROM accessible)
     GROUP BY p.id
     ORDER BY p.name, p.id`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    parentProjectId: r.parent_project_id,
    createdAt: r.created_at,
    ownerId: r.owner_id,
    diagramCount: Number(r.diagram_count),
  }));
}

/** A soft-deleted project is not-found for this and every other regular (non-admin-recovery)
 *  purpose — matches getDiagram's own precedent. */
export async function getProject(id: string): Promise<ProjectRecord> {
  const db = getDb();
  const row = await db
    .selectFrom('projects')
    .select(['id', 'name', 'parent_project_id', 'created_at'])
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!row) throw new ProjectNotFoundError(`No project with id ${id}`);
  return {
    id: row.id,
    name: row.name,
    parentProjectId: row.parent_project_id,
    createdAt: row.created_at as unknown as string,
  };
}

/** Renames a project (canvas-228.3). Access (owner-or-admin) is enforced by the route's
 *  `requireProjectOwnerOrAdmin` preHandler, not here — this function trusts its caller. */
export async function renameProject(id: string, name: string): Promise<ProjectRecord> {
  const db = getDb();
  const row = await db
    .updateTable('projects')
    .set({ name })
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .returning(['id', 'name', 'parent_project_id', 'created_at'])
    .executeTakeFirst();
  if (!row) throw new ProjectNotFoundError(`No project with id ${id}`);
  return {
    id: row.id,
    name: row.name,
    parentProjectId: row.parent_project_id,
    createdAt: row.created_at as unknown as string,
  };
}

/**
 * Soft-deletes a project (canvas-228.2), but only if it has no content to lose: zero direct
 * non-deleted diagrams and zero child projects (this app has no UI to ever create nested
 * projects, so the latter is a defensive guard against orphaning rather than a real feature).
 * Idempotent, mirroring deleteDiagram: deleting an already-deleted project succeeds silently.
 */
export async function deleteProject(id: string, deletedByUserId: string): Promise<void> {
  const db = getDb();
  const project = await db.selectFrom('projects').select('deleted_at').where('id', '=', id).executeTakeFirst();
  if (!project) {
    throw new ProjectNotFoundError(`No project with id ${id}`);
  }
  if (project.deleted_at !== null) return; // already deleted — idempotent success

  const [{ diagram_count: diagramCount }, { child_count: childCount }] = await Promise.all([
    db
      .selectFrom('diagrams')
      .select(sql<string>`COUNT(*)`.as('diagram_count'))
      .where('project_id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('projects')
      .select(sql<string>`COUNT(*)`.as('child_count'))
      .where('parent_project_id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow(),
  ]);
  if (Number(diagramCount) > 0 || Number(childCount) > 0) {
    throw new ProjectHasContentError('Only a project with no diagrams and no sub-projects can be deleted.');
  }

  await db.updateTable('projects').set({ deleted_at: new Date(), deleted_by_user_id: deletedByUserId }).where('id', '=', id).execute();
}

export interface DeletedProjectSummary {
  id: string;
  name: string;
  ownerId: string;
  deletedAt: string;
}

/** Admin-only listing of soft-deleted projects still within their retention window (canvas-228.2). */
export async function listDeletedProjects(): Promise<DeletedProjectSummary[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('projects')
    .select(['id', 'name', 'owner_id', 'deleted_at'])
    .where('deleted_at', 'is not', null)
    .where('deleted_at', '>', retentionBoundary())
    .orderBy('deleted_at', 'desc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    deletedAt: r.deleted_at as unknown as string,
  }));
}

/** Restores a soft-deleted project within its retention window, recording who/when. */
export async function restoreProject(id: string, restoredByUserId: string): Promise<void> {
  const db = getDb();
  const row = await db.selectFrom('projects').select('deleted_at').where('id', '=', id).executeTakeFirst();
  if (!row || row.deleted_at === null) {
    throw new ProjectNotFoundError(`No soft-deleted project with id ${id}`);
  }
  if (!(row.deleted_at > retentionBoundary())) {
    throw new ProjectRetentionExpiredError('This project is no longer available to restore.');
  }
  await db
    .updateTable('projects')
    .set({ deleted_at: null, deleted_by_user_id: null, restored_at: new Date(), restored_by_user_id: restoredByUserId })
    .where('id', '=', id)
    .execute();
}

export interface ProjectTreeNode {
  id: string;
  name: string;
  diagrams: { id: string; name: string; diagramTypeId: string }[];
  children: ProjectTreeNode[];
}

/**
 * Full nested tree for the project browser UI (FR-016).
 *
 * Scoped to the requested subtree. It previously read EVERY project and EVERY non-deleted diagram
 * in the installation on each call and discarded all but the requested branch — a full scan of
 * the two largest tables to build one project's tree (feature 007, research.md §1).
 *
 * Deliberately NOT converted to Kysely (canvas-jtm.4 scope — see listProjectsForUser's own note
 * above): this function's own `WITH RECURSIVE subtree` is canvas-jtm.5's job.
 */
export async function getProjectTree(rootId: string): Promise<ProjectTreeNode> {
  const pool = getPool();
  const { rows: subtreeProjects } = await pool.query<{ id: string; name: string; parent_project_id: string | null }>(
    `WITH RECURSIVE subtree AS (
       SELECT id, name, parent_project_id FROM projects WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT p.id, p.name, p.parent_project_id
       FROM projects p JOIN subtree s ON p.parent_project_id = s.id
       WHERE p.deleted_at IS NULL
     )
     SELECT id, name, parent_project_id FROM subtree`,
    [rootId],
  );

  const root = subtreeProjects.find((p) => p.id === rootId);
  if (!root) throw new ProjectNotFoundError(`No project with id ${rootId}`);

  const { rows: subtreeDiagrams } = await pool.query<{
    id: string;
    name: string;
    diagram_type_id: string;
    project_id: string;
  }>(
    // Secondary tiebreak on id: without it, rows with an identical created_at timestamp (common
    // when tests create many diagrams in rapid succession) have no guaranteed stable order
    // across repeated queries, which shows up as flaky "pick the most recent" test failures.
    `SELECT id, name, diagram_type_id, project_id FROM diagrams
     WHERE deleted_at IS NULL AND project_id = ANY($1::uuid[])
     ORDER BY created_at DESC, id DESC`,
    [subtreeProjects.map((p) => p.id)],
  );

  const childrenByParent = new Map<string, typeof subtreeProjects>();
  for (const project of subtreeProjects) {
    const key = project.parent_project_id ?? '';
    childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), project]);
  }
  const diagramsByProject = new Map<string, typeof subtreeDiagrams>();
  for (const diagram of subtreeDiagrams) {
    diagramsByProject.set(diagram.project_id, [...(diagramsByProject.get(diagram.project_id) ?? []), diagram]);
  }

  const allProjects = subtreeProjects;

  const build = (project: (typeof allProjects)[number]): ProjectTreeNode => ({
    id: project.id,
    name: project.name,
    diagrams: (diagramsByProject.get(project.id) ?? []).map((d) => ({ id: d.id, name: d.name, diagramTypeId: d.diagram_type_id })),
    children: (childrenByParent.get(project.id) ?? []).map(build),
  });

  return build(root);
}
