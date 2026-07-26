import { getPool } from '../db/pool.js';
import type { UserRole } from '../auth/types.js';

export class UserNotFoundError extends Error {}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  personas: string[];
  active: boolean;
}

export async function listUsers(): Promise<UserRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<UserRecord>(
    'SELECT id, name, email, role, personas, active FROM users ORDER BY name',
  );
  return rows;
}

export interface UpdateUserInput {
  role?: UserRole;
  personas?: string[];
  active?: boolean;
}

/** Assigns/changes a user's role, personas, or active status (FR-022) — admin console only. */
export async function updateUser(id: string, input: UpdateUserInput): Promise<UserRecord> {
  const pool = getPool();
  const { rows } = await pool.query<UserRecord>(
    `UPDATE users SET
       role = COALESCE($2, role),
       personas = COALESCE($3, personas),
       active = COALESCE($4, active)
     WHERE id = $1
     RETURNING id, name, email, role, personas, active`,
    [id, input.role ?? null, input.personas ?? null, input.active ?? null],
  );
  if (!rows[0]) {
    throw new UserNotFoundError(`No user with id ${id}`);
  }
  return rows[0];
}

export interface AdminOverview {
  userCount: number;
  standardsCount: number;
  publishedStandardsCount: number;
  libraryCount: number;
}

/** Single aggregated view for the admin console landing page (FR-023). */
export async function getAdminOverview(): Promise<AdminOverview> {
  const pool = getPool();
  const [{ rows: userRows }, { rows: standardRows }, { rows: libraryRows }] = await Promise.all([
    pool.query<{ count: string }>('SELECT COUNT(*) FROM users'),
    pool.query<{ total: string; published: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'published') AS published FROM standards`,
    ),
    pool.query<{ count: string }>('SELECT COUNT(*) FROM icon_libraries'),
  ]);
  return {
    userCount: Number(userRows[0].count),
    standardsCount: Number(standardRows[0].total),
    publishedStandardsCount: Number(standardRows[0].published),
    libraryCount: Number(libraryRows[0].count),
  };
}
