import { getPool } from '../db/pool.js';
import { ACCESSIBLE_PROJECT_IDS_SQL } from './project.access.js';

export class ProjectNotFoundError extends Error {}
export class ProjectCycleError extends Error {}

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

export async function getProject(id: string): Promise<ProjectRecord> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; name: string; parent_project_id: string | null; created_at: string }>(
    'SELECT id, name, parent_project_id, created_at FROM projects WHERE id = $1',
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
    'UPDATE projects SET name = $2 WHERE id = $1 RETURNING id, name, parent_project_id, created_at',
    [id, name],
  );
  if (!rows[0]) throw new ProjectNotFoundError(`No project with id ${id}`);
  return { id: rows[0].id, name: rows[0].name, parentProjectId: rows[0].parent_project_id, createdAt: rows[0].created_at };
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
       SELECT id, name, parent_project_id FROM projects WHERE id = $1
       UNION ALL
       SELECT p.id, p.name, p.parent_project_id
       FROM projects p JOIN subtree s ON p.parent_project_id = s.id
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
