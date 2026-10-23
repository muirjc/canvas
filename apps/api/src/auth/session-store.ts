import type { SessionStore } from '@fastify/session';
import type { Kysely } from 'kysely';
import { getDb } from '../db/client.js';
import type { DB } from '../db/schema.js';
import { dbBoolean, fromDbBoolean } from '../db/sql-helpers.js';

/**
 * canvas-4xo: a database-backed @fastify/session store. The library's default MemoryStore lost
 * every session on restart, grew without bound and couldn't be shared by more than one replica.
 *
 * A row is the session serialized as JSON (its cookie options -- including the rolling expiry the
 * library checks on restore -- plus our own fields). `expires_at` mirrors that expiry in epoch
 * milliseconds so expired rows can be ignored and pruned with one numeric comparison on either
 * database engine.
 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

type Callback = Parameters<SessionStore['destroy']>[1];
type GetCallback = Parameters<SessionStore['get']>[1];
type StoredSession = NonNullable<Parameters<GetCallback>[1]>;
type SessionToStore = Parameters<SessionStore['set']>[1];

export class DbSessionStore implements SessionStore {
  private lastPrune = 0;

  constructor(private readonly idleMs: number) {}

  get(sessionId: string, callback: GetCallback): void {
    const now = Date.now();
    const db = getDb();
    db.selectFrom('sessions')
      .select(['data', 'expires_at', 'revoked'])
      .where('id', '=', sessionId)
      .executeTakeFirst()
      .then(async (row) => {
        // canvas-bj7: a revoked session stays ended, whatever cookie still points at it.
        if (!row || fromDbBoolean(row.revoked)) return null;
        if (Number(row.expires_at) <= now) {
          // Expired: remove it now rather than waiting for the next prune.
          await db.deleteFrom('sessions').where('id', '=', sessionId).execute();
          return null;
        }
        return JSON.parse(row.data) as StoredSession;
      })
      .then((session) => callback(null, session))
      .catch((error: unknown) => callback(error));
  }

  set(sessionId: string, session: SessionToStore, callback: Callback): void {
    const expires = session.cookie?.expires;
    const expiresAt = expires ? new Date(expires).getTime() : Date.now() + this.idleMs;
    const data = JSON.stringify(session);
    const userId = (session as { user?: { id?: string } }).user?.id ?? null;
    getDb()
      .insertInto('sessions')
      .values({ id: sessionId, data, expires_at: expiresAt, user_id: userId })
      // canvas-bj7: never over a revoked row. A request that was in flight when this session was
      // ended (sign-out, an admin action) saves it again at the end of its response; that save
      // must not bring the session back.
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({ data, expires_at: expiresAt, user_id: userId }).where('sessions.revoked', '=', dbBoolean(false)),
      )
      .execute()
      .then(() => this.pruneIfDue())
      .then(() => callback())
      .catch((error: unknown) => callback(error));
  }

  /** canvas-bj7: revokes rather than deletes -- see set(). The row (scrubbed) goes at its expiry. */
  destroy(sessionId: string, callback: Callback): void {
    revokeSessions({ id: sessionId })
      .then(() => callback())
      .catch((error: unknown) => callback(error));
  }

  /** Deletes expired rows, at most once per PRUNE_INTERVAL_MS per process. */
  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    await getDb().deleteFrom('sessions').where('expires_at', '<=', now).execute();
  }
}

/**
 * canvas-ez1.2: ends every session belonging to `userId` -- after an admin resets their password
 * or deactivates them -- except `keepSessionId` (a user changing their own password stays signed
 * in on that device).
 */
export async function destroyUserSessions(userId: string, keepSessionId?: string): Promise<void> {
  await revokeSessions({ userId, exceptId: keepSessionId });
}

/**
 * canvas-bj7: ends the matching sessions for good: marked revoked (so a late save can't re-create
 * them -- DbSessionStore.set) and their contents scrubbed. Pruned at expiry like any other row.
 */
export async function revokeSessions(
  filter: { id?: string; userId?: string; exceptId?: string },
  db: Kysely<DB> = getDb(),
): Promise<void> {
  if (!filter.id && !filter.userId) throw new Error('revokeSessions needs an id or a userId');
  let query = db.updateTable('sessions').set({ revoked: dbBoolean(true), data: '{}' });
  if (filter.id) query = query.where('id', '=', filter.id);
  if (filter.userId) query = query.where('user_id', '=', filter.userId);
  if (filter.exceptId) query = query.where('id', '!=', filter.exceptId);
  await query.execute();
}
