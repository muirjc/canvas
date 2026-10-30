import { getDb } from '../db/client.js';
import { toDate } from '../db/sql-helpers.js';

/**
 * canvas-obp0: who else has a diagram open in the editor. Each editor tab sends a heartbeat every
 * HEARTBEAT_SECONDS; a tab not heard from for EXPIRY_SECONDS no longer counts (closed laptop,
 * lost network). Advisory only -- stale saves are stopped by the save's base version check.
 */
export const HEARTBEAT_SECONDS = 30;
export const EXPIRY_SECONDS = 90;

export interface OtherEditor {
  userId: string;
  name: string;
  /** When this person opened the diagram (their tab's first heartbeat). */
  since: string;
  /** The same person in another tab or browser. */
  isYou: boolean;
}

/**
 * Records this tab's heartbeat and returns everyone else with the diagram open: other people
 * first, then the caller's own other tabs. Expired rows are removed on the way.
 */
export async function heartbeat(diagramId: string, userId: string, sessionId: string, now = new Date()): Promise<OtherEditor[]> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - EXPIRY_SECONDS * 1000);
  await db.deleteFrom('diagram_edit_sessions').where('diagram_id', '=', diagramId).where('last_seen_at', '<', cutoff).execute();
  await db
    .insertInto('diagram_edit_sessions')
    .values({ diagram_id: diagramId, user_id: userId, session_id: sessionId, started_at: now, last_seen_at: now })
    .onConflict((oc) => oc.columns(['diagram_id', 'user_id', 'session_id']).doUpdateSet({ last_seen_at: now }))
    .execute();

  const rows = await db
    .selectFrom('diagram_edit_sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['s.user_id', 's.session_id', 's.started_at', 'u.name', 'u.email'])
    .where('s.diagram_id', '=', diagramId)
    .execute();

  // One entry per person: someone with two tabs open is still one other editor, shown with the
  // earliest time they opened it.
  // A session id is "<tab>.<mount>" (web/usePresence.ts): the caller's own tab, in any mount, isn't
  // "someone else" -- an earlier mount whose goodbye hasn't landed yet is the same editor.
  const tabOf = (id: string) => id.split('.')[0];
  const byKey = new Map<string, OtherEditor>();
  for (const row of rows) {
    if (row.user_id === userId && tabOf(row.session_id) === tabOf(sessionId)) continue;
    const isYou = row.user_id === userId;
    const since = toDate(row.started_at as unknown as Date | string).toISOString();
    const existing = byKey.get(row.user_id);
    if (!existing || since < existing.since) {
      byKey.set(row.user_id, { userId: row.user_id, name: isYou ? 'You' : (row.name ?? row.email), since, isYou });
    }
  }
  return [...byKey.values()].sort((a, b) => Number(a.isYou) - Number(b.isYou) || a.since.localeCompare(b.since));
}

/** This tab closed the editor. Best effort: a tab that never says goodbye simply expires. */
export async function leave(diagramId: string, userId: string, sessionId: string): Promise<void> {
  await getDb()
    .deleteFrom('diagram_edit_sessions')
    .where('diagram_id', '=', diagramId)
    .where('user_id', '=', userId)
    .where('session_id', '=', sessionId)
    .execute();
}
