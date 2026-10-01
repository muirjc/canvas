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
 *
 * canvas-jtm.5: converted from raw `WITH RECURSIVE` SQL to Kysely's `.withRecursive()` — this is
 * the epic's own dedicated, authorization-critical-risk phase (a mismatch here is a security bug,
 * over- or under-granting access, not just a feature bug), so every query here keeps the exact
 * same semantics as the SQL it replaces, including preserving plain `UNION` (not `UNION ALL`)
 * everywhere the original did, which is what makes a project hierarchy with no real cycles safe to
 * walk without ever producing a duplicate row.
 */
import { sql, type Kysely } from 'kysely';
import { getDb } from '../db/client.js';
import type { DB } from '../db/schema.js';
import type { AccessLevel } from '../sharing/sharing.service.js';

/**
 * A project's ancestor chain, nearest first: the project itself, then its parent, and so on.
 * Empty when the project does not exist — which the caller must distinguish from "no access",
 * because a 403 on a nonexistent id implies it exists and is merely out of reach.
 */
async function ancestorChain(projectId: string): Promise<Array<{ id: string; owner_id: string }>> {
  const db = getDb();
  const rows = await db
    .withRecursive('chain', (qb) =>
      qb
        .selectFrom('projects')
        .select(['id', 'parent_project_id', 'owner_id', sql<number>`0`.as('depth')])
        .where('id', '=', projectId)
        .where('deleted_at', 'is', null)
        .unionAll((eb) =>
          eb
            .selectFrom('projects as p')
            .innerJoin('chain as c', 'c.parent_project_id', 'p.id')
            .select(['p.id', 'p.parent_project_id', 'p.owner_id', sql<number>`c.depth + 1`.as('depth')])
            .where('p.deleted_at', 'is', null),
        ),
    )
    .selectFrom('chain')
    .select(['id', 'owner_id'])
    .orderBy('depth')
    .execute();
  return rows;
}

/** canvas-228.2: a soft-deleted project counts as not existing for every regular (non-admin-
 *  recovery) purpose — matches how a soft-deleted diagram's getDiagram already behaves. */
export async function projectExists(projectId: string): Promise<boolean> {
  const db = getDb();
  const row = await db.selectFrom('projects').select('id').where('id', '=', projectId).where('deleted_at', 'is', null).executeTakeFirst();
  return Boolean(row);
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

  const db = getDb();
  const user = await db.selectFrom('users').select('role').where('id', '=', userId).executeTakeFirst();
  if (user?.role === 'admin') return 'edit';

  // A grant on the project or on any ancestor. Nearest ancestor wins, matching the chain order.
  const grants = await db
    .selectFrom('share_grants')
    .select(['subject_id', 'access_level'])
    .where('subject_type', '=', 'project')
    .where('grantee_user_id', '=', userId)
    .where(
      'subject_id',
      'in',
      chain.map((p) => p.id),
    )
    .execute();
  if (grants.length === 0) return undefined;

  const byId = new Map(grants.map((g) => [g.subject_id, g.access_level]));
  for (const link of chain) {
    const level = byId.get(link.id);
    if (level) return level;
  }
  return undefined;
}

/**
 * Registers the `roots`/`accessible` recursive CTEs on `db` (every project the user can see:
 * those they own or have been granted, plus every descendant of those) and returns the extended
 * query context — callers continue from it with their own `.selectFrom(...)`, filtering on
 * `WHERE p.id IN (SELECT id FROM accessible)` exactly like `listProjectsForUser` does.
 *
 * Shares its definition with `resolveProjectAccess` above by construction — both express "owned
 * or granted, inherited downward". Admins see everything, matching `resolveProjectAccess` and
 * `resolveDiagramAccess`.
 */
export function withAccessibleProjects(db: Kysely<DB>, userId: string) {
  return db
    .withRecursive('roots', (qb) =>
      qb
        .selectFrom('projects')
        .select('id')
        .where('owner_id', '=', userId)
        .where('deleted_at', 'is', null)
        .union((eb) =>
          eb
            .selectFrom('share_grants as sg')
            .innerJoin('projects as p', 'p.id', 'sg.subject_id')
            .select('sg.subject_id as id')
            .where('sg.subject_type', '=', 'project')
            .where('sg.grantee_user_id', '=', userId)
            .where('p.deleted_at', 'is', null),
        )
        .union((eb) =>
          eb
            .selectFrom('projects')
            .select('id')
            .where((wb) =>
              wb.exists(
                wb.selectFrom('users').select(sql`1`.as('one')).where('id', '=', userId).where('role', '=', 'admin'),
              ),
            )
            .where('deleted_at', 'is', null),
        ),
    )
    .withRecursive('accessible', (qb) =>
      qb
        .selectFrom('roots')
        .select('id')
        .union((eb) =>
          eb
            .selectFrom('projects as p')
            .innerJoin('accessible as a', 'a.id', 'p.parent_project_id')
            .select('p.id')
            .where('p.deleted_at', 'is', null),
        ),
    );
}
