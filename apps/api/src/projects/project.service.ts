import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '../db/client.js';
import { dbBoolean, toDate } from '../db/sql-helpers.js';
import { projectAccessForUser } from './project.access.js';
import type { AccessLevel } from '../sharing/access-levels.js';

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
  /** canvas-2h2w.1: the caller's effective access (View at least: every project is readable). */
  accessLevel: AccessLevel;
  /** canvas-2h2w.1: 'owner' / 'member' put it under "My projects"; null = readable, not joined. */
  membership: 'owner' | 'member' | null;
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
    .values({ id: randomUUID(), name: input.name, parent_project_id: input.parentProjectId ?? null, owner_id: input.ownerId })
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
    accessLevel: 'manage',
    membership: 'owner',
  };
}

/**
 * Every live project, with the user's access to each (canvas-2h2w.1: everyone signed in can read
 * every project). The level comes from `project.access.ts` -- the same rule as the route guard,
 * so the list never promises more than the routes allow.
 *
 * Ordered by name so the chooser is stable between loads. No search or paging: the clarified
 * scale is tens of projects (FR-013e).
 */
export async function listProjectsForUser(userId: string): Promise<ProjectListItem[]> {
  const db = getDb();
  const access = await projectAccessForUser(userId);
  const rows = await db
    .selectFrom('projects as p')
    .leftJoin('diagrams as d', (join) => join.onRef('d.project_id', '=', 'p.id').on('d.deleted_at', 'is', null).on('d.draft', '=', dbBoolean(false)))
    .select([
      'p.id',
      'p.name',
      'p.parent_project_id',
      'p.created_at',
      'p.owner_id',
      sql<string>`COUNT(d.id)`.as('diagram_count'),
    ])
    .where('p.deleted_at', 'is', null)
    .groupBy('p.id')
    .orderBy('p.name')
    .orderBy('p.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    parentProjectId: r.parent_project_id,
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    createdAt: r.created_at as unknown as string,
    ownerId: r.owner_id,
    diagramCount: Number(r.diagram_count),
    accessLevel: access.get(r.id)?.level ?? 'view',
    membership: access.get(r.id)?.membership ?? null,
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
      .where('draft', '=', dbBoolean(false))
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
  if (!(toDate(row.deleted_at) > retentionBoundary())) {
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
 * `unionAll`, not `union` (canvas-jtm.5): this walks DOWN from one root with no re-converging
 * paths possible (every project has exactly one parent), unlike `project.access.ts`'s `roots`/
 * `accessible` CTEs, which combine multiple sources that genuinely can overlap and so need real
 * `UNION` deduplication — preserved exactly as the original SQL had each, not normalized to one.
 */
export async function getProjectTree(rootId: string): Promise<ProjectTreeNode> {
  const db = getDb();
  const subtreeProjects = await db
    .withRecursive('subtree', (qb) =>
      qb
        .selectFrom('projects')
        .select(['id', 'name', 'parent_project_id'])
        .where('id', '=', rootId)
        .where('deleted_at', 'is', null)
        .unionAll((eb) =>
          eb
            .selectFrom('projects as p')
            .innerJoin('subtree as s', 's.id', 'p.parent_project_id')
            .select(['p.id', 'p.name', 'p.parent_project_id'])
            .where('p.deleted_at', 'is', null),
        ),
    )
    .selectFrom('subtree')
    .select(['id', 'name', 'parent_project_id'])
    .execute();

  const root = subtreeProjects.find((p) => p.id === rootId);
  if (!root) throw new ProjectNotFoundError(`No project with id ${rootId}`);

  const subtreeDiagrams = await db
    .selectFrom('diagrams')
    .select(['id', 'name', 'diagram_type_id', 'project_id'])
    .where('deleted_at', 'is', null)
    // canvas-j6v: an unsaved Create with AI draft isn't in any list, even its creator's.
    .where('draft', '=', dbBoolean(false))
    .where(
      'project_id',
      'in',
      subtreeProjects.map((p) => p.id),
    )
    // Secondary tiebreak on id: without it, rows with an identical created_at timestamp (common
    // when tests create many diagrams in rapid succession) have no guaranteed stable order
    // across repeated queries, which shows up as flaky "pick the most recent" test failures.
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();

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

/**
 * Ids of soft-deleted projects past their retention window (canvas-d3m) -- the candidates
 * purgeExpiredProjects() considers. Split out so `npm run purge -- --dry-run` can list them.
 */
export async function findExpiredProjectIds(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom('projects')
    .select('id')
    .where('deleted_at', 'is not', null)
    .where('deleted_at', '<=', retentionBoundary())
    .execute();
  return rows.map((r) => r.id);
}

export interface ProjectPurgeResult {
  purgedProjectIds: string[];
  /** Expired projects left in place because something still points at them. */
  skipped: { id: string; reason: string }[];
}

/**
 * Physically deletes projects past their retention window (canvas-d3m), the project counterpart
 * of purgeExpiredDiagrams() (jmuir-yvh) and invoked the same way, from the ops-run purge script.
 *
 * A project is purged only once nothing references it: no diagram rows in any state (diagrams.
 * project_id has no ON DELETE CASCADE, and a soft-deleted diagram still inside its own retention
 * window must stay restorable) and no child project rows (parent_project_id DOES cascade, so
 * deleting the parent would silently destroy them). deleteProject() already refuses to soft-delete
 * a project with live content, so normally a project's diagrams were deleted before it and expire
 * first -- the purge script runs purgeExpiredDiagrams() before this. Anything still referenced is
 * skipped and reported, never deleted. Expired children are purged before their expired parents
 * (one pass per level). share_grants has no FK, so its project grants are deleted explicitly.
 */
export async function purgeExpiredProjects(): Promise<ProjectPurgeResult> {
  const db = getDb();
  const purged: string[] = [];
  let remaining = await findExpiredProjectIds();
  const blockReasons = new Map<string, string>();

  while (remaining.length > 0) {
    const [diagramRows, childRows] = await Promise.all([
      db.selectFrom('diagrams').select('project_id').where('project_id', 'in', remaining).groupBy('project_id').execute(),
      db.selectFrom('projects').select('parent_project_id').where('parent_project_id', 'in', remaining).groupBy('parent_project_id').execute(),
    ]);
    blockReasons.clear();
    for (const row of diagramRows) blockReasons.set(row.project_id, 'still contains diagrams');
    for (const row of childRows) {
      if (row.parent_project_id && !blockReasons.has(row.parent_project_id)) blockReasons.set(row.parent_project_id, 'still has sub-projects');
    }
    const ready = remaining.filter((id) => !blockReasons.has(id));
    if (ready.length === 0) break;

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('share_grants').where('subject_type', '=', 'project').where('subject_id', 'in', ready).execute();
      await trx.deleteFrom('projects').where('id', 'in', ready).execute();
    });
    purged.push(...ready);
    remaining = remaining.filter((id) => blockReasons.has(id));
  }

  return {
    purgedProjectIds: purged,
    skipped: remaining.map((id) => ({ id, reason: blockReasons.get(id) ?? 'still referenced' })),
  };
}

export interface ProjectMember {
  grantId: string;
  userId: string;
  name: string | null;
  email: string | null;
  accessLevel: AccessLevel;
}

export interface ProjectMembers {
  owner: { id: string; name: string | null; email: string | null };
  members: ProjectMember[];
}

/** canvas-2h2w.2: who owns a project and who has been added to it (its project share grants). */
export async function listProjectMembers(projectId: string): Promise<ProjectMembers> {
  const db = getDb();
  const project = await db
    .selectFrom('projects as p')
    .leftJoin('users as u', 'u.id', 'p.owner_id')
    .select(['p.owner_id', 'u.name', 'u.email'])
    .where('p.id', '=', projectId)
    .where('p.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!project) throw new ProjectNotFoundError(`No project with id ${projectId}`);
  const rows = await db
    .selectFrom('share_grants as g')
    .leftJoin('users as u', 'u.id', 'g.grantee_user_id')
    .select(['g.id', 'g.grantee_user_id', 'g.access_level', 'u.name', 'u.email'])
    .where('g.subject_type', '=', 'project')
    .where('g.subject_id', '=', projectId)
    .orderBy('u.name')
    .orderBy('g.id')
    .execute();
  return {
    owner: { id: project.owner_id, name: project.name, email: project.email },
    members: rows.map((r) => ({ grantId: r.id, userId: r.grantee_user_id, name: r.name, email: r.email, accessLevel: r.access_level })),
  };
}

export class NewOwnerNotFoundError extends Error {}

/**
 * canvas-2h2w.2: hands a project to someone else (the route allows the owner or an admin). The new
 * owner's member entry goes (owning already gives Manage), and the previous owner stays on as a
 * Manage member, so nobody loses access by accident. Returns the previous owner, or null if the
 * project already belonged to `newOwnerId`.
 */
export async function transferProjectOwnership(projectId: string, newOwnerId: string, actorId: string): Promise<string | null> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const project = await trx.selectFrom('projects').select('owner_id').where('id', '=', projectId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!project) throw new ProjectNotFoundError(`No project with id ${projectId}`);
    const newOwner = await trx.selectFrom('users').select(['id', 'role']).where('id', '=', newOwnerId).where('active', '=', dbBoolean(true)).executeTakeFirst();
    if (!newOwner) throw new NewOwnerNotFoundError(`No active user with id ${newOwnerId}`);
    if (newOwner.role === 'viewer') throw new NewOwnerNotFoundError('A viewer can only read and comment, so they cannot own a project.');
    if (project.owner_id === newOwnerId) return null;

    await trx.updateTable('projects').set({ owner_id: newOwnerId }).where('id', '=', projectId).execute();
    await trx
      .deleteFrom('share_grants')
      .where('subject_type', '=', 'project')
      .where('subject_id', '=', projectId)
      .where('grantee_user_id', '=', newOwnerId)
      .execute();
    await trx
      .insertInto('share_grants')
      .values({
        id: randomUUID(),
        subject_type: 'project',
        subject_id: projectId,
        grantee_user_id: project.owner_id,
        access_level: 'manage',
        granted_by_user_id: actorId,
      })
      .onConflict((oc) => oc.columns(['subject_type', 'subject_id', 'grantee_user_id']).doUpdateSet({ access_level: 'manage' }))
      .execute();
    return project.owner_id;
  });
}
