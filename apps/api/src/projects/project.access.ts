/**
 * The single definition of "which projects can this user see" (feature 007, FR-013a).
 *
 * Both callers — the route guard (`requireProjectAccess`) and the project list (`listForUser`) —
 * MUST come through here. Two implementations of this rule would drift, and drift between what
 * the list shows and what the guard allows is a data leak rather than a display bug.
 *
 * Before this feature no route taking a project id checked anything beyond authentication, so
 * any signed-in user could read any project's entire diagram tree by id
 * (specs/007-project-context/research.md §1).
 */
import { getPool } from '../db/pool.js';
import type { AccessLevel } from '../sharing/sharing.service.js';

/**
 * A project's ancestor chain, nearest first: the project itself, then its parent, and so on.
 * Empty when the project does not exist — which the caller must distinguish from "no access",
 * because a 403 on a nonexistent id implies it exists and is merely out of reach.
 */
async function ancestorChain(projectId: string): Promise<Array<{ id: string; owner_id: string }>> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; owner_id: string; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_project_id, owner_id, 0 AS depth
       FROM projects WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_project_id, p.owner_id, c.depth + 1
       FROM projects p JOIN chain c ON p.id = c.parent_project_id
     )
     SELECT id, owner_id, depth FROM chain ORDER BY depth`,
    [projectId],
  );
  return rows.map((r) => ({ id: r.id, owner_id: r.owner_id }));
}

export async function projectExists(projectId: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  return Boolean(rows[0]);
}

/**
 * Resolves the user's access to a project, or `undefined` for none (and for a project that does
 * not exist — callers check `projectExists` when they need to tell those apart).
 *
 * Access inherits DOWNWARD only: holding a parent grants its descendants, because that is what
 * `GET /projects/:id/tree` returns and a tree with holes in it serves nobody. Holding a child
 * grants nothing about its parent or siblings (data-model.md).
 */
export async function resolveProjectAccess(
  userId: string,
  projectId: string,
): Promise<AccessLevel | undefined> {
  const chain = await ancestorChain(projectId);
  if (chain.length === 0) return undefined;

  // Owning the project or any ancestor of it.
  if (chain.some((p) => p.owner_id === userId)) return 'edit';

  const pool = getPool();
  const { rows: userRows } = await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
  if (userRows[0]?.role === 'admin') return 'edit';

  // A grant on the project or on any ancestor. Nearest ancestor wins, matching the chain order.
  const { rows: grants } = await pool.query<{ subject_id: string; access_level: AccessLevel }>(
    `SELECT subject_id, access_level FROM share_grants
     WHERE subject_type = 'project' AND grantee_user_id = $1 AND subject_id = ANY($2::uuid[])`,
    [userId, chain.map((p) => p.id)],
  );
  if (grants.length === 0) return undefined;

  const byId = new Map(grants.map((g) => [g.subject_id, g.access_level]));
  for (const link of chain) {
    const level = byId.get(link.id);
    if (level) return level;
  }
  return undefined;
}

/**
 * SQL naming every project the user can see: those they own or have been granted, plus every
 * descendant of those. Shares its definition with `resolveProjectAccess` above by construction —
 * both express "owned or granted, inherited downward".
 *
 * Admins see everything, matching `resolveProjectAccess` and `resolveDiagramAccess`.
 */
export const ACCESSIBLE_PROJECT_IDS_SQL = `
  WITH RECURSIVE roots AS (
    SELECT p.id FROM projects p WHERE p.owner_id = $1
    UNION
    SELECT sg.subject_id FROM share_grants sg
      WHERE sg.subject_type = 'project' AND sg.grantee_user_id = $1
    UNION
    SELECT p.id FROM projects p
      WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.role = 'admin')
  ),
  accessible AS (
    SELECT id FROM roots
    UNION
    SELECT p.id FROM projects p JOIN accessible a ON p.parent_project_id = a.id
  )
`;
