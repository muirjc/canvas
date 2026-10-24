import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '../db/client.js';
import { toDate } from '../db/sql-helpers.js';

/**
 * canvas-bw4: comments on a diagram. A thread is a root comment plus replies; it may be pinned to
 * a shape or connector and resolved. Deleting keeps the row (deleted_at, body cleared) so a thread
 * still reads. Access (view to read, comment/edit to post) is checked by the routes.
 */

export const MAX_COMMENT_LENGTH = 4000;

export class CommentNotFoundError extends Error {}
export class CommentForbiddenError extends Error {}
export class CommentInvalidError extends Error {}

export interface CommentRecord {
  id: string;
  threadRootId: string | null;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface ThreadRecord extends CommentRecord {
  anchor: { type: 'node' | 'edge'; id: string } | null;
  resolved: { at: string; by: string | null } | null;
  replies: CommentRecord[];
}

const iso = (v: Date | string | null) => (v ? toDate(v).toISOString() : null);

export async function listThreads(diagramId: string): Promise<ThreadRecord[]> {
  const rows = await getDb()
    .selectFrom('diagram_comments as c')
    .innerJoin('users as a', 'a.id', 'c.author_id')
    .leftJoin('users as r', 'r.id', 'c.resolved_by_user_id')
    .where('c.diagram_id', '=', diagramId)
    .select([
      'c.id',
      'c.thread_root_id',
      'c.author_id',
      'a.name as author_name',
      'c.body',
      'c.anchor_type',
      'c.anchor_id',
      'c.created_at',
      'c.edited_at',
      'c.deleted_at',
      'c.resolved_at',
      'r.name as resolved_by_name',
    ])
    .orderBy('c.created_at')
    .orderBy('c.id')
    .execute();
  const toComment = (r: (typeof rows)[number]): CommentRecord => ({
    id: r.id,
    threadRootId: r.thread_root_id,
    author: { id: r.author_id, name: r.author_name },
    body: r.deleted_at ? '' : r.body,
    createdAt: iso(r.created_at)!,
    editedAt: iso(r.edited_at),
    deleted: Boolean(r.deleted_at),
  });
  const threads = new Map<string, ThreadRecord>();
  for (const r of rows.filter((x) => !x.thread_root_id)) {
    threads.set(r.id, {
      ...toComment(r),
      anchor: r.anchor_type && r.anchor_id ? { type: r.anchor_type, id: r.anchor_id } : null,
      resolved: r.resolved_at ? { at: iso(r.resolved_at)!, by: r.resolved_by_name } : null,
      replies: [],
    });
  }
  for (const r of rows.filter((x) => x.thread_root_id)) threads.get(r.thread_root_id!)?.replies.push(toComment(r));
  // A thread whose root and every reply are deleted has nothing left to read.
  return [...threads.values()].filter((t) => !(t.deleted && t.replies.every((c) => c.deleted)));
}

function cleanBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new CommentInvalidError('A comment needs some text.');
  if (trimmed.length > MAX_COMMENT_LENGTH) throw new CommentInvalidError(`Comments can be at most ${MAX_COMMENT_LENGTH} characters.`);
  return trimmed;
}

export async function addComment(input: {
  diagramId: string;
  authorId: string;
  body: string;
  threadRootId?: string;
  anchor?: { type: 'node' | 'edge'; id: string };
}): Promise<string> {
  const db = getDb();
  const body = cleanBody(input.body);
  if (input.threadRootId) {
    const root = await db
      .selectFrom('diagram_comments')
      .select(['id', 'thread_root_id'])
      .where('id', '=', input.threadRootId)
      .where('diagram_id', '=', input.diagramId)
      .executeTakeFirst();
    if (!root || root.thread_root_id) throw new CommentNotFoundError('No such thread on this diagram.');
  }
  const id = randomUUID();
  await db
    .insertInto('diagram_comments')
    .values({
      id,
      diagram_id: input.diagramId,
      thread_root_id: input.threadRootId ?? null,
      author_id: input.authorId,
      body,
      // Replies belong to their thread's pin; only a new thread is pinned.
      anchor_type: input.threadRootId ? null : (input.anchor?.type ?? null),
      anchor_id: input.threadRootId ? null : (input.anchor?.id ?? null),
      created_at: new Date(),
    })
    .execute();
  return id;
}

async function getComment(diagramId: string, commentId: string) {
  const row = await getDb()
    .selectFrom('diagram_comments')
    .select(['id', 'author_id', 'thread_root_id', 'deleted_at'])
    .where('id', '=', commentId)
    .where('diagram_id', '=', diagramId)
    .executeTakeFirst();
  if (!row || row.deleted_at) throw new CommentNotFoundError('No such comment on this diagram.');
  return row;
}

export async function editComment(input: { diagramId: string; commentId: string; userId: string; body: string }): Promise<void> {
  const comment = await getComment(input.diagramId, input.commentId);
  if (comment.author_id !== input.userId) throw new CommentForbiddenError('Only the author can edit a comment.');
  await getDb()
    .updateTable('diagram_comments')
    .set({ body: cleanBody(input.body), edited_at: new Date() })
    .where('id', '=', input.commentId)
    .execute();
}

/** Author, the diagram's owner or an admin. The row stays (body cleared) so the thread reads on. */
export async function deleteComment(input: { diagramId: string; commentId: string; userId: string; isAdmin: boolean }): Promise<void> {
  const comment = await getComment(input.diagramId, input.commentId);
  if (comment.author_id !== input.userId && !input.isAdmin) {
    const diagram = await getDb().selectFrom('diagrams').select('owner_id').where('id', '=', input.diagramId).executeTakeFirst();
    if (diagram?.owner_id !== input.userId) {
      throw new CommentForbiddenError("Only the author, the diagram's owner or an admin can delete a comment.");
    }
  }
  await getDb().updateTable('diagram_comments').set({ deleted_at: new Date(), body: '' }).where('id', '=', input.commentId).execute();
}

export async function setResolved(input: { diagramId: string; threadRootId: string; userId: string; resolved: boolean }): Promise<void> {
  // A thread can be resolved even if its first comment was deleted (its replies still read).
  const root = await getDb()
    .selectFrom('diagram_comments')
    .select(['id', 'thread_root_id'])
    .where('id', '=', input.threadRootId)
    .where('diagram_id', '=', input.diagramId)
    .executeTakeFirst();
  if (!root) throw new CommentNotFoundError('No such thread on this diagram.');
  if (root.thread_root_id) throw new CommentInvalidError('Resolve the thread, not a reply.');
  await getDb()
    .updateTable('diagram_comments')
    .set(input.resolved ? { resolved_at: new Date(), resolved_by_user_id: input.userId } : { resolved_at: null, resolved_by_user_id: null })
    .where('id', '=', input.threadRootId)
    .execute();
}

/** Comments by others, still visible, posted since this user last looked. */
export async function unreadCount(diagramId: string, userId: string): Promise<number> {
  const db = getDb();
  const read = await db
    .selectFrom('diagram_comment_reads')
    .select('last_read_at')
    .where('user_id', '=', userId)
    .where('diagram_id', '=', diagramId)
    .executeTakeFirst();
  let query = db
    .selectFrom('diagram_comments')
    .select(sql<string>`COUNT(*)`.as('count'))
    .where('diagram_id', '=', diagramId)
    .where('author_id', '!=', userId)
    .where('deleted_at', 'is', null);
  if (read) query = query.where('created_at', '>', toDate(read.last_read_at));
  return Number((await query.executeTakeFirstOrThrow()).count);
}

export async function markRead(diagramId: string, userId: string): Promise<void> {
  const now = new Date();
  await getDb()
    .insertInto('diagram_comment_reads')
    .values({ user_id: userId, diagram_id: diagramId, last_read_at: now })
    .onConflict((oc) => oc.columns(['user_id', 'diagram_id']).doUpdateSet({ last_read_at: now }))
    .execute();
}
