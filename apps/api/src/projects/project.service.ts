import { getPool } from '../db/pool.js';

export class ProjectNotFoundError extends Error {}
export class ProjectCycleError extends Error {}

export interface ProjectRecord {
  id: string;
  name: string;
  parentProjectId: string | null;
  createdAt: string;
}

export interface CreateProjectInput {
  name: string;
  parentProjectId?: string;
}

/**
 * Creates a Project/Folder (FR-016). Projects are only ever attached to a parent at creation
 * time (there is no re-parenting endpoint), so a brand-new row can never be its own ancestor —
 * cycle prevention here means rejecting a parentProjectId that doesn't exist, which is the only
 * way a cycle could otherwise be introduced later.
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectRecord> {
  const pool = getPool();
  if (input.parentProjectId) {
    const { rows } = await pool.query('SELECT id FROM projects WHERE id = $1', [input.parentProjectId]);
    if (!rows[0]) {
      throw new ProjectCycleError(`Parent project ${input.parentProjectId} does not exist`);
    }
  }
  const { rows } = await pool.query<{ id: string; name: string; parent_project_id: string | null; created_at: string }>(
    'INSERT INTO projects (name, parent_project_id) VALUES ($1, $2) RETURNING id, name, parent_project_id, created_at',
    [input.name, input.parentProjectId ?? null],
  );
  return { id: rows[0].id, name: rows[0].name, parentProjectId: rows[0].parent_project_id, createdAt: rows[0].created_at };
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

export interface ProjectTreeNode {
  id: string;
  name: string;
  diagrams: { id: string; name: string; diagramTypeId: string }[];
  children: ProjectTreeNode[];
}

/** Full nested tree for the project browser UI (FR-016). */
export async function getProjectTree(rootId: string): Promise<ProjectTreeNode> {
  const pool = getPool();
  const { rows: allProjects } = await pool.query<{ id: string; name: string; parent_project_id: string | null }>(
    'SELECT id, name, parent_project_id FROM projects',
  );
  const { rows: allDiagrams } = await pool.query<{ id: string; name: string; diagram_type_id: string; project_id: string }>(
    // Secondary tiebreak on id: without it, rows with an identical created_at timestamp (common
    // when tests create many diagrams in rapid succession) have no guaranteed stable order
    // across repeated queries, which shows up as flaky "pick the most recent" test failures.
    'SELECT id, name, diagram_type_id, project_id FROM diagrams WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC',
  );

  const childrenByParent = new Map<string, typeof allProjects>();
  for (const project of allProjects) {
    const key = project.parent_project_id ?? '';
    childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), project]);
  }
  const diagramsByProject = new Map<string, typeof allDiagrams>();
  for (const diagram of allDiagrams) {
    diagramsByProject.set(diagram.project_id, [...(diagramsByProject.get(diagram.project_id) ?? []), diagram]);
  }

  const root = allProjects.find((p) => p.id === rootId);
  if (!root) throw new ProjectNotFoundError(`No project with id ${rootId}`);

  const build = (project: (typeof allProjects)[number]): ProjectTreeNode => ({
    id: project.id,
    name: project.name,
    diagrams: (diagramsByProject.get(project.id) ?? []).map((d) => ({ id: d.id, name: d.name, diagramTypeId: d.diagram_type_id })),
    children: (childrenByParent.get(project.id) ?? []).map(build),
  });

  return build(root);
}
