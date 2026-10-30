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
import { sql } from 'kysely';
import { getDb } from '../db/client.js';
import { capForRole, highestAccess, type AccessLevel } from '../sharing/access-levels.js';

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
 * Resolves the user's access to a project (canvas-2h2w.1, docs/sharing-design.md): everyone signed
 * in can read every project (View); owning the project or an ancestor, or being an admin, is
 * Manage; a project grant on it or any ancestor counts too. The HIGHEST of these wins (it used to
 * be the nearest grant), then the viewer role caps it at Comment. Undefined only for a project that
 * doesn't exist (or is deleted).
 *
 * Access still inherits DOWNWARD only: membership of a parent covers its descendants, never the
 * other way round.
 */
export async function resolveProjectAccess(
  userId: string,
  projectId: string,
): Promise<AccessLevel | undefined> {
  const chain = await ancestorChain(projectId);
  if (chain.length === 0) return undefined;

  const db = getDb();
  const user = await db.selectFrom('users').select('role').where('id', '=', userId).executeTakeFirst();
  const grants = await db
    .selectFrom('share_grants')
    .select('access_level')
    .where('subject_type', '=', 'project')
    .where('grantee_user_id', '=', userId)
    .where(
      'subject_id',
      'in',
      chain.map((p) => p.id),
    )
    .execute();

  const owns = chain.some((p) => p.owner_id === userId);
  return capForRole(
    highestAccess('view', owns || user?.role === 'admin' ? 'manage' : undefined, ...grants.map((g) => g.access_level)),
    user?.role,
  );
}

export interface ProjectAccessEntry {
  level: AccessLevel;
  /** How the user belongs, ignoring open read and the admin role: 'owner' (of it or an ancestor),
   *  'member' (a project grant on it or an ancestor), or null (they can only read it). The
   *  Projects page lists owners and members under "My projects". */
  membership: 'owner' | 'member' | null;
}

/**
 * Every live project's access for one user, for the project list -- the same rule as
 * resolveProjectAccess, computed for all projects at once (tens of projects, so in memory).
 */
export async function projectAccessForUser(userId: string): Promise<Map<string, ProjectAccessEntry>> {
  const db = getDb();
  const [projects, user, grants] = await Promise.all([
    db.selectFrom('projects').select(['id', 'parent_project_id', 'owner_id']).where('deleted_at', 'is', null).execute(),
    db.selectFrom('users').select('role').where('id', '=', userId).executeTakeFirst(),
    db
      .selectFrom('share_grants')
      .select(['subject_id', 'access_level'])
      .where('subject_type', '=', 'project')
      .where('grantee_user_id', '=', userId)
      .execute(),
  ]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const grantFor = new Map(grants.map((g) => [g.subject_id, g.access_level]));
  const result = new Map<string, ProjectAccessEntry>();
  for (const project of projects) {
    let owns = false;
    const levels: AccessLevel[] = [];
    // Walk up the tree; `seen` guards against a (never expected) cycle.
    const seen = new Set<string>();
    for (let p: typeof project | undefined = project; p && !seen.has(p.id); p = p.parent_project_id ? byId.get(p.parent_project_id) : undefined) {
      seen.add(p.id);
      if (p.owner_id === userId) owns = true;
      const granted = grantFor.get(p.id);
      if (granted) levels.push(granted);
    }
    const level = capForRole(
      highestAccess('view', owns || user?.role === 'admin' ? 'manage' : undefined, ...levels),
      user?.role,
    )!;
    result.set(project.id, { level, membership: owns ? 'owner' : levels.length > 0 ? 'member' : null });
  }
  return result;
}
