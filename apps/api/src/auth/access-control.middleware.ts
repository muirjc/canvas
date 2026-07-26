import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db/pool.js';
import { accessAtLeast, resolveDiagramAccess, type AccessLevel } from '../sharing/sharing.service.js';

/**
 * Enforces a minimum access level on a `/diagrams/:id...` route (FR-020/FR-021): a user without
 * at least `required` access is blocked and told why, never silently allowed through. Owners and
 * admins always resolve to "edit" (sharing.service.ts).
 *
 * A nonexistent diagram id is deliberately let through to the route handler rather than 403'd
 * here, so callers still see the route's own 404 ("no diagram with id X") instead of a
 * misleading 403 that implies the diagram exists but is inaccessible.
 */
/**
 * Authorizes diagram deletion (FR-011): ownership or the admin role — deliberately NOT the
 * view/comment/edit sharing ladder (research.md §2, feature 002), so a user granted "edit"
 * access can't delete a diagram out from under its owner. A nonexistent diagram id is let
 * through for the same reason as `requireDiagramAccess` above.
 */
export function requireDiagramOwnerOrAdmin() {
  return async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const user = request.session.user;
    if (!user) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    const pool = getPool();
    const { rows } = await pool.query<{ owner_id: string }>('SELECT owner_id FROM diagrams WHERE id = $1', [
      request.params.id,
    ]);
    if (!rows[0]) return; // let the route's own not-found handling fire

    if (rows[0].owner_id !== user.id && user.role !== 'admin') {
      reply.code(403).send({ error: 'Only this diagram\'s owner or an admin can delete it.' });
    }
  };
}

export function requireDiagramAccess(required: AccessLevel) {
  return async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const user = request.session.user;
    if (!user) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    const pool = getPool();
    const { rows } = await pool.query('SELECT 1 FROM diagrams WHERE id = $1', [request.params.id]);
    if (!rows[0]) return; // let the route's own not-found handling fire

    const level = await resolveDiagramAccess(user.id, request.params.id);
    if (!accessAtLeast(level, required)) {
      reply.code(403).send({
        error: level
          ? `This action requires "${required}" access, but you only have "${level}" access to this diagram.`
          : 'You do not have access to this diagram.',
      });
    }
  };
}
