import { sql } from 'kysely';
import { getDb } from '../db/client.js';
import { getUserPersonas, getUserPersonasBatch, setUserPersonas } from '../db/array-columns.js';
import { dbBoolean, fromDbBoolean } from '../db/sql-helpers.js';
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
  return rows.map((r) => ({ ...r, active: fromDbBoolean(r.active), personas: personasByUser.get(r.id) ?? [] }));
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
        .set({ role: input.role ?? undefined, active: input.active === undefined ? undefined : dbBoolean(input.active) })
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
    return { ...row, active: fromDbBoolean(row.active), personas: await getUserPersonas(trx, id) };
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
  const db = getDb();
  const [userRow, standardRow, libraryRow] = await Promise.all([
    db.selectFrom('users').select(sql<string>`COUNT(*)`.as('count')).executeTakeFirstOrThrow(),
    db
      .selectFrom('standards')
      .select([
        sql<string>`COUNT(*)`.as('total'),
        // Portable replacement for COUNT(*) FILTER (WHERE status = 'published') — FILTER isn't
        // supported by every engine (MySQL lacks it; SQLite only added it in 3.30+), so this uses
        // the ANSI-standard SUM(CASE WHEN ...) form instead (canvas-jtm.4).
        sql<string>`SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END)`.as('published'),
      ])
      .executeTakeFirstOrThrow(),
    db.selectFrom('icon_libraries').select(sql<string>`COUNT(*)`.as('count')).executeTakeFirstOrThrow(),
  ]);
  return {
    userCount: Number(userRow.count),
    standardsCount: Number(standardRow.total),
    publishedStandardsCount: Number(standardRow.published),
    libraryCount: Number(libraryRow.count),
  };
}
