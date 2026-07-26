import { getPool } from '../db/pool.js';

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
  const pool = getPool();
  const { rows: granteeRows } = await pool.query('SELECT id FROM users WHERE id = $1 AND active = true', [
    input.granteeUserId,
  ]);
  if (!granteeRows[0]) {
    throw new GranteeNotFoundError(`No active user with id ${input.granteeUserId}`);
  }

  const { rows } = await pool.query<{
    id: string;
    subject_type: SubjectType;
    subject_id: string;
    grantee_user_id: string;
    access_level: AccessLevel;
    granted_by_user_id: string;
    created_at: string;
  }>(
    `INSERT INTO share_grants (subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subject_type, subject_id, grantee_user_id) DO UPDATE SET access_level = EXCLUDED.access_level
     RETURNING id, subject_type, subject_id, grantee_user_id, access_level, granted_by_user_id, created_at`,
    [input.subjectType, input.subjectId, input.granteeUserId, input.accessLevel, input.grantedByUserId],
  );
  const row = rows[0];
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    granteeUserId: row.grantee_user_id,
    accessLevel: row.access_level,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at,
  };
}

export async function listShareGrants(subjectType: SubjectType, subjectId: string): Promise<ShareGrantRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    subject_type: SubjectType;
    subject_id: string;
    grantee_user_id: string;
    access_level: AccessLevel;
    granted_by_user_id: string;
    created_at: string;
  }>('SELECT * FROM share_grants WHERE subject_type = $1 AND subject_id = $2', [subjectType, subjectId]);
  return rows.map((row) => ({
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    granteeUserId: row.grantee_user_id,
    accessLevel: row.access_level,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at,
  }));
}

export async function revokeShareGrant(id: string): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query('DELETE FROM share_grants WHERE id = $1', [id]);
  if (!rowCount) {
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
  const pool = getPool();
  const { rows: diagramRows } = await pool.query<{ owner_id: string; project_id: string }>(
    'SELECT owner_id, project_id FROM diagrams WHERE id = $1',
    [diagramId],
  );
  const diagram = diagramRows[0];
  if (!diagram) return undefined;
  if (diagram.owner_id === userId) return 'edit';

  const { rows: userRows } = await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
  if (userRows[0]?.role === 'admin') return 'edit';

  const { rows: diagramGrant } = await pool.query<{ access_level: AccessLevel }>(
    `SELECT access_level FROM share_grants WHERE subject_type = 'diagram' AND subject_id = $1 AND grantee_user_id = $2`,
    [diagramId, userId],
  );
  if (diagramGrant[0]) return diagramGrant[0].access_level;

  const { rows: projectGrant } = await pool.query<{ access_level: AccessLevel }>(
    `SELECT access_level FROM share_grants WHERE subject_type = 'project' AND subject_id = $1 AND grantee_user_id = $2`,
    [diagram.project_id, userId],
  );
  return projectGrant[0]?.access_level;
}

export function accessAtLeast(level: AccessLevel | undefined, required: AccessLevel): boolean {
  if (!level) return false;
  return ACCESS_RANK[level] >= ACCESS_RANK[required];
}
