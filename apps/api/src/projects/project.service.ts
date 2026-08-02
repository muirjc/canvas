import { getPool } from '../db/pool.js';
import { ACCESSIBLE_PROJECT_IDS_SQL } from './project.access.js';

export class ProjectNotFoundError extends Error {}
export class ProjectCycleError extends Error {}
export class ProjectHasContentError extends Error {}
export class ProjectRetentionExpiredError extends Error {}

/** Soft-deleted projects older than this are no longer restorable (canvas-228.2), mirroring
 *  DIAGRAM_RETENTION_DAYS in diagram.service.ts — same policy, separate constant because it's a
 *  different table's rule, not because the value should ever differ. */
export const PROJECT_RETENTION_DAYS = 30;

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
  const pool = getPool();
  if (input.parentProjectId) {
    const { rows } = await pool.query('SELECT id FROM projects WHERE id = $1', [input.parentProjectId]);
    if (!rows[0]) {
      throw new ProjectCycleError(`Parent project ${input.parentProjectId} does not exist`);
    }
  }
  const { rows } = await pool.query<{ id: string; name: string; parent_project_id: string | null; created_at: string }>(
    `INSERT INTO projects (name, parent_project_id, owner_id) VALUES ($1, $2, $3)
     RETURNING id, name, parent_project_id, created_at`,
    [input.name, input.parentProjectId ?? null, input.ownerId],
  );
  // Always 0 — a brand-new project cannot already have a diagram in it. ownerId is already known
  // (it's the input, not read back) — no need to re-query for it.
  return {
    id: rows[0].id,
    name: rows[0].name,
    parentProjectId: rows[0].parent_project_id,
    createdAt: rows[0].created_at,
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
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; name: string; parent_project_id: string | null; created_at: string }>(
    'SELECT id, name, parent_project_id, created_at FROM projects WHERE id = $1 AND deleted_at IS NULL',
    [id],
  );
  if (!rows[0]) throw new ProjectNotFoundError(`No project with id ${id}`);
  return { id: rows[0].id, name: rows[0].name, parentProjectId: rows[0].parent_project_id, createdAt: rows[0].created_at };
}

/** Renames a project (canvas-228.3). Access (owner-or-admin) is enforced by the route's
 *  `requireProjectOwnerOrAdmin` preHandler, not here — this function trusts its caller. */
export async function renameProject(id: string, name: string): Promise<ProjectRecord> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; name: string; parent_project_id: string | null; created_at: string }>(
    'UPDATE projects SET name = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, parent_project_id, created_at',
    [id, name],
  );
  if (!rows[0]) throw new ProjectNotFoundError(`No project with id ${id}`);
  return { id: rows[0].id, name: rows[0].name, parentProjectId: rows[0].parent_project_id, createdAt: rows[0].created_at };
}

/**
 * Soft-deletes a project (canvas-228.2), but only if it has no content to lose: zero direct
 * non-deleted diagrams and zero child projects (this app has no UI to ever create nested
 * projects, so the latter is a defensive guard against orphaning rather than a real feature).
 * Idempotent, mirroring deleteDiagram: deleting an already-deleted project succeeds silently.
 */
export async function deleteProject(id: string, deletedByUserId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM projects WHERE id = $1', [id]);
  if (!rows[0]) {
    throw new ProjectNotFoundError(`No project with id ${id}`);
  }
  if (rows[0].deleted_at !== null) return; // already deleted — idempotent success

  const { rows: contentRows } = await pool.query<{ diagram_count: string; child_count: string }>(
    `SELECT
       (SELECT COUNT(*) FROM diagrams WHERE project_id = $1 AND deleted_at IS NULL) AS diagram_count,
       (SELECT COUNT(*) FROM projects WHERE parent_project_id = $1 AND deleted_at IS NULL) AS child_count`,
    [id],
  );
  if (Number(contentRows[0].diagram_count) > 0 || Number(contentRows[0].child_count) > 0) {
    throw new ProjectHasContentError('Only a project with no diagrams and no sub-projects can be deleted.');
  }

  await pool.query('UPDATE projects SET deleted_at = now(), deleted_by_user_id = $2 WHERE id = $1', [id, deletedByUserId]);
}

export interface DeletedProjectSummary {
  id: string;
  name: string;
  ownerId: string;
  deletedAt: string;
}

/** Admin-only listing of soft-deleted projects still within their retention window (canvas-228.2). */
export async function listDeletedProjects(): Promise<DeletedProjectSummary[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; name: string; owner_id: string; deleted_at: string }>(
    `SELECT id, name, owner_id, deleted_at FROM projects
     WHERE deleted_at IS NOT NULL AND deleted_at > now() - make_interval(days => $1)
     ORDER BY deleted_at DESC`,
    [PROJECT_RETENTION_DAYS],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, deletedAt: r.deleted_at }));
}

/** Restores a soft-deleted project within its retention window, recording who/when. */
export async function restoreProject(id: string, restoredByUserId: string): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{ deleted_at: string | null }>('SELECT deleted_at FROM projects WHERE id = $1', [id]);
  if (!rows[0] || rows[0].deleted_at === null) {
    throw new ProjectNotFoundError(`No soft-deleted project with id ${id}`);
  }
  const { rows: windowRows } = await pool.query<{ within_window: boolean }>(
    `SELECT deleted_at > now() - make_interval(days => $2) AS within_window FROM projects WHERE id = $1`,
    [id, PROJECT_RETENTION_DAYS],
  );
  if (!windowRows[0].within_window) {
    throw new ProjectRetentionExpiredError('This project is no longer available to restore.');
  }
  await pool.query(
    'UPDATE projects SET deleted_at = NULL, deleted_by_user_id = NULL, restored_at = now(), restored_by_user_id = $2 WHERE id = $1',
    [id, restoredByUserId],
  );
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
