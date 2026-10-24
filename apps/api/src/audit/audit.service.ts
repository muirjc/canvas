import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { getDb } from '../db/client.js';
import type { DB } from '../db/schema.js';

/**
 * canvas-ez1.4: the audit log -- with Canvas-managed passwords (AUTH_MODE=local) there's no
 * identity provider keeping a sign-in log, so Canvas keeps its own. Never records a password.
 */
export type AuditEvent =
  | 'sign_in'
  | 'sign_in_failed'
  | 'account_locked'
  | 'account_unlocked'
  | 'password_changed'
  | 'password_change_failed'
  | 'password_reset'
  | 'user_created'
  | 'user_updated'
  | 'mfa_enrolled'
  | 'mfa_reset'
  | 'ai_price_set'
  | 'ai_price_removed'
  | 'user_deleted'
  // canvas-3s5.1: GitHub approval
  | 'github_link_set'
  | 'github_link_removed'
  | 'diagram_submitted'
  | 'diagram_submission_merged'
  | 'diagram_submission_closed'
  | 'diagram_submission_withdrawn';

export interface AuditEntry {
  event: AuditEvent;
  actorUserId?: string | null;
  targetUserId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordAudit(entry: AuditEntry, db: Kysely<DB> = getDb()): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      id: randomUUID(),
      occurred_at: new Date(),
      event: entry.event,
      actor_user_id: entry.actorUserId ?? null,
      target_user_id: entry.targetUserId ?? null,
      ip: entry.ip ?? null,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
    })
    .execute();
}

/**
 * The client's address as Azure Container Apps' ingress saw it: the LAST X-Forwarded-For entry
 * (the one the ingress appended). request.ip (trustProxy: true) is the FIRST entry, which the
 * client can set to anything -- so the rate limiter and the audit log both use this instead.
 */
export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const last = header?.split(',').pop()?.trim();
  return last || request.socket.remoteAddress || request.ip;
}

export interface AuditEventRecord {
  id: string;
  occurredAt: string;
  event: string;
  actorEmail: string | null;
  targetEmail: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
}

/** Newest first. `before` (an occurredAt from the previous page) pages backwards. */
export async function listAuditEvents(options: { limit: number; before?: string; userId?: string }): Promise<AuditEventRecord[]> {
  let query = getDb()
    .selectFrom('audit_events')
    // audit_events' user columns are TEXT (SQLite mirror, and no FK so history outlives a user) but
    // Postgres users.id is UUID, so compare as text -- `uuid = text` has no operator.
    .leftJoin('users as actor', 'actor.id', 'audit_events.actor_user_id')
    .leftJoin('users as target', 'target.id', 'audit_events.target_user_id')
    .select([
      'audit_events.id',
      'audit_events.occurred_at',
      'audit_events.event',
      'audit_events.ip',
      'audit_events.detail',
      'actor.email as actor_email',
      'target.email as target_email',
    ])
    .orderBy('audit_events.occurred_at', 'desc')
    .orderBy('audit_events.id', 'desc')
    .limit(options.limit);
  if (options.before) query = query.where('audit_events.occurred_at', '<', new Date(options.before));
  if (options.userId) {
    const userId = options.userId;
    query = query.where((eb) => eb.or([eb('audit_events.actor_user_id', '=', userId), eb('audit_events.target_user_id', '=', userId)]));
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    event: r.event,
    actorEmail: r.actor_email,
    targetEmail: r.target_email,
    ip: r.ip,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}
