import { getDb } from '../db/client.js';

export type AccessLevel = 'view' | 'comment' | 'edit';
export type SubjectType = 'diagram' | 'project';

export class GranteeNotFoundError extends Error {}
export class ShareGrantNotFoundError extends Error {}

export interface ShareGrantRecord {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  granteeUserId: string;
  accessLevel: AccessLevel;
  grantedByUserId: string;
  createdAt: string;
}

function toRecord(row: {
  id: string;
  subject_type: SubjectType;
  subject_id: string;
  grantee_user_id: string;
  access_level: AccessLevel;
  granted_by_user_id: string;
  created_at: Date;
}): ShareGrantRecord {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    granteeUserId: row.grantee_user_id,
    accessLevel: row.access_level,
    grantedByUserId: row.granted_by_user_id,
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    createdAt: row.created_at as unknown as string,
  };
}

export interface CreateShareGrantInput {
  subjectType: SubjectType;
  subjectId: string;
  granteeUserId: string;
  accessLevel: AccessLevel;
  grantedByUserId: string;
}

/** Grants a user a specific access level to a Diagram or Project (FR-020). Org-internal only
 * (FR-026) — grantee must be an active user already in this deployment's user table. */
export async function createShareGrant(input: CreateShareGrantInput): Promise<ShareGrantRecord> {
  const db = getDb();
  const grantee = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', input.granteeUserId)
    .where('active', '=', true)
    .executeTakeFirst();
  if (!grantee) {
    throw new GranteeNotFoundError(`No active user with id ${input.granteeUserId}`);
  }

  const row = await db
    .insertInto('share_grants')
    .values({
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      grantee_user_id: input.granteeUserId,
      access_level: input.accessLevel,
      granted_by_user_id: input.grantedByUserId,
    })
    .onConflict((oc) =>
      oc.columns(['subject_type', 'subject_id', 'grantee_user_id']).doUpdateSet((eb) => ({
        access_level: eb.ref('excluded.access_level'),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRecord(row);
}

export async function listShareGrants(subjectType: SubjectType, subjectId: string): Promise<ShareGrantRecord[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('share_grants')
    .selectAll()
    .where('subject_type', '=', subjectType)
    .where('subject_id', '=', subjectId)
    .execute();
  return rows.map(toRecord);
}

export async function revokeShareGrant(id: string): Promise<void> {
  const db = getDb();
  const result = await db.deleteFrom('share_grants').where('id', '=', id).executeTakeFirst();
  if (result.numDeletedRows === 0n) {
    throw new ShareGrantNotFoundError(`No share grant with id ${id}`);
  }
}

const ACCESS_RANK: Record<AccessLevel, number> = { view: 1, comment: 2, edit: 3 };

/**
 * Resolves a user's effective access level to a diagram: owner or admin → edit; otherwise the
 * most specific applicable grant — a diagram-level grant overrides an inherited project-level
 * one for the same user (data-model.md's ShareGrant validation rule).
 */
export async function resolveDiagramAccess(
  userId: string,
  diagramId: string,
): Promise<AccessLevel | undefined> {
  const db = getDb();
  const diagram = await db
    .selectFrom('diagrams')
    .select(['owner_id', 'project_id'])
    .where('id', '=', diagramId)
    .executeTakeFirst();
  if (!diagram) return undefined;
  if (diagram.owner_id === userId) return 'edit';

  const user = await db.selectFrom('users').select('role').where('id', '=', userId).executeTakeFirst();
  if (user?.role === 'admin') return 'edit';

  const diagramGrant = await db
    .selectFrom('share_grants')
    .select('access_level')
    .where('subject_type', '=', 'diagram')
    .where('subject_id', '=', diagramId)
    .where('grantee_user_id', '=', userId)
    .executeTakeFirst();
  if (diagramGrant) return diagramGrant.access_level;

  const projectGrant = await db
    .selectFrom('share_grants')
    .select('access_level')
    .where('subject_type', '=', 'project')
    .where('subject_id', '=', diagram.project_id)
    .where('grantee_user_id', '=', userId)
    .executeTakeFirst();
  return projectGrant?.access_level;
}

export interface SharedDiagramEntry {
  diagramId: string;
  diagramName: string;
  diagramTypeId: string;
  projectName: string;
  accessLevel: AccessLevel;
  sharedByName: string;
  sharedByEmail: string;
  sharedAt: string;
}

/**
 * Diagrams shared directly with a user (feature 008, FR-001). Deliberately a single join with no
 * access-resolution logic layered on top — research.md §1 found that shape alone already
 * satisfies every requirement:
 *
 * - A revoked grant has no `share_grants` row to join from, so it is simply absent (FR-011).
 * - A diagram the user could also reach via project access is not excluded — this never checks
 *   project access at all, so there is nothing to exclude it with (FR-006).
 * - `accessLevel` is the grant's own stored value, identical to what `resolveDiagramAccess` would
 *   return for a diagram-level grant (FR-004) — nothing here recomputes it.
 * - `projectName` is the diagram's immediate `project_id` only, never an ancestor (FR-005).
 * - `sharedByName`/`sharedByEmail` are joined without an `active = true` filter: a grant made
 *   while the sharer was active remains attributed to them regardless of their current status
 *   (FR-007).
 */
export async function listSharedDiagramsForUser(userId: string): Promise<SharedDiagramEntry[]> {
  const db = getDb();
  const rows = await db
    .selectFrom('share_grants as sg')
    .innerJoin('diagrams as d', 'd.id', 'sg.subject_id')
    .innerJoin('projects as p', 'p.id', 'd.project_id')
    .innerJoin('users as u', 'u.id', 'sg.granted_by_user_id')
    .select([
      'd.id as diagram_id',
      'd.name as diagram_name',
      'd.diagram_type_id',
      'p.name as project_name',
      'sg.access_level',
      'u.name as shared_by_name',
      'u.email as shared_by_email',
      'sg.created_at as shared_at',
    ])
    .where('sg.subject_type', '=', 'diagram')
    .where('sg.grantee_user_id', '=', userId)
    .where('d.deleted_at', 'is', null)
    .orderBy('d.name')
    .orderBy('d.id')
    .execute();
  return rows.map((r) => ({
    diagramId: r.diagram_id,
    diagramName: r.diagram_name,
    diagramTypeId: r.diagram_type_id,
    projectName: r.project_name,
    accessLevel: r.access_level,
    sharedByName: r.shared_by_name,
    sharedByEmail: r.shared_by_email,
    // See diagram-chat.service.ts's getChatMessages for why this cast is the pre-existing
    // convention, not a new behavior change — node-postgres always returned a Date here.
    sharedAt: r.shared_at as unknown as string,
  }));
}

export function accessAtLeast(level: AccessLevel | undefined, required: AccessLevel): boolean {
  if (!level) return false;
  return ACCESS_RANK[level] >= ACCESS_RANK[required];
}
