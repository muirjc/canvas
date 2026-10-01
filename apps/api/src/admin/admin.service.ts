import { getPool } from '../db/pool.js';
import { getDb } from '../db/client.js';
import { getUserPersonas, getUserPersonasBatch, setUserPersonas } from '../db/array-columns.js';
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
  const db = getDb();
  const rows = await db.selectFrom('users').select(['id', 'name', 'email', 'role', 'active']).orderBy('name').execute();
  const personasByUser = await getUserPersonasBatch(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, personas: personasByUser.get(r.id) ?? [] }));
}

export interface UpdateUserInput {
  role?: UserRole;
  personas?: string[];
  active?: boolean;
}

/**
 * Assigns/changes a user's role, personas, or active status (FR-022) — admin console only.
 * Wrapped in one transaction so a role/active change and a personas replacement either both land
 * or neither does — the single `UPDATE ... RETURNING` statement this replaces was atomic by
 * construction; splitting the write across the `users` row and the `users_personas` join table
 * needs an explicit transaction to keep that same guarantee.
 */
export async function updateUser(id: string, input: UpdateUserInput): Promise<UserRecord> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    // Kysely's `.set()` omits an `undefined`-valued key entirely (unlike the raw-SQL `COALESCE`
    // pattern this replaces, which needed a real self-referencing fallback), but an object with
    // EVERY key omitted compiles to an empty SET clause — invalid SQL ("syntax error at or near
    // 'where'"), confirmed live via a personas-only PATCH (no role/active) during canvas-jtm.3's
    // own manual verification. Skip the `users` row update entirely rather than ever calling
    // `.set({})` — a personas-only input then updates only `users_personas` below.
    let row: { id: string; name: string; email: string; role: UserRole; active: boolean } | undefined;
    if (input.role !== undefined || input.active !== undefined) {
      row = await trx
        .updateTable('users')
        .set({ role: input.role ?? undefined, active: input.active ?? undefined })
        .where('id', '=', id)
        .returning(['id', 'name', 'email', 'role', 'active'])
        .executeTakeFirst();
    } else {
      row = await trx.selectFrom('users').select(['id', 'name', 'email', 'role', 'active']).where('id', '=', id).executeTakeFirst();
    }
    if (!row) {
      throw new UserNotFoundError(`No user with id ${id}`);
    }
    if (input.personas !== undefined) {
      await setUserPersonas(trx, id, input.personas);
    }
    return { ...row, personas: await getUserPersonas(trx, id) };
  });
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
