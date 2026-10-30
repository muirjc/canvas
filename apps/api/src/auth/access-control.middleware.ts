import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { fromDbBoolean } from '../db/sql-helpers.js';
import { projectExists, resolveProjectAccess } from '../projects/project.access.js';
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
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const db = getDb();
    const row = await db
      .selectFrom('diagrams')
      .select(['owner_id', 'draft'])
      .where('id', '=', request.params.id)
      .executeTakeFirst();
    if (!row) return; // let the route's own not-found handling fire
    if (isOthersDraft(row, user.id)) return reply.code(404).send({ error: 'Diagram not found' });

    if (row.owner_id !== user.id && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Only this diagram\'s owner or an admin can delete it.' });
    }
  };
}

/**
 * Authorizes project rename/delete (canvas-228.3/canvas-228.2): ownership or the admin role,
 * mirroring `requireDiagramOwnerOrAdmin` above exactly and for the same reason — the permissive
 * edit-share ladder (`requireProjectAccess`) must not let a user rename or delete a project out
 * from under its owner. A nonexistent project id is let through for the same reason.
 */
export function requireProjectOwnerOrAdmin() {
  return async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const user = request.session.user;
    if (!user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const db = getDb();
    const row = await db
      .selectFrom('projects')
      .select('owner_id')
      .where('id', '=', request.params.id)
      .executeTakeFirst();
    if (!row) return; // let the route's own not-found handling fire

    if (row.owner_id !== user.id && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Only this project\'s owner or an admin can do that.' });
    }
  };
}

/**
 * Enforces a minimum access level on a route that takes a project id (feature 007, FR-013a).
 * Before this, every such route was guarded by `requireAuth` alone, so any signed-in user could
 * read any project's entire diagram tree by id.
 *
 * `paramName` is REQUIRED and has deliberately no default. The five guarded routes are split
 * across two parameter names — `/projects/:id` and `/projects/:projectId/diagrams` — so a default
 * of `'id'` would read `undefined` on three of them, find no project, fall through as
 * "nonexistent", and leave those routes completely unguarded while every happy-path test stayed
 * green. An absent parameter is treated as a wiring mistake and fails closed with a 500 rather
 * than silently allowing the request.
 *
 * A nonexistent project id falls through to the route's own 404, for the same reason as
 * `requireDiagramAccess` above.
 */
export function requireProjectAccess(required: AccessLevel, paramName: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.session.user;
    if (!user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    const projectId = (request.params as Record<string, string | undefined>)[paramName];
    if (!projectId) {
      request.log.error(
        { paramName, params: request.params, url: request.url },
        'requireProjectAccess was given a parameter name this route does not define — refusing the request rather than letting it through unchecked',
      );
      return reply.code(500).send({ error: 'Access control is misconfigured for this route.' });
    }

    if (!(await projectExists(projectId))) return; // let the route's own not-found handling fire

    const level = await resolveProjectAccess(user.id, projectId);
    if (!accessAtLeast(level, required)) {
      return reply.code(403).send({
        error: level
          ? `This action requires "${required}" access, but you only have "${level}" access to this project.`
          : 'You do not have access to this project.',
      });
    }
  };
}

/** canvas-j6v/tmpr: an unsaved new diagram (draft) exists only for its creator -- to anyone else,
 *  admins included, it isn't there at all. */
function isOthersDraft(row: { owner_id: string; draft: boolean }, userId: string): boolean {
  return fromDbBoolean(row.draft) && row.owner_id !== userId;
}

export function requireDiagramAccess(required: AccessLevel) {
  return async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<void> => {
    const user = request.session.user;
    if (!user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const db = getDb();
    const row = await db.selectFrom('diagrams').select(['owner_id', 'draft']).where('id', '=', request.params.id).executeTakeFirst();
    if (!row) return; // let the route's own not-found handling fire
    if (isOthersDraft(row, user.id)) return reply.code(404).send({ error: 'Diagram not found' });

    const level = await resolveDiagramAccess(user.id, request.params.id);
    if (!accessAtLeast(level, required)) {
      return reply.code(403).send({
        error: level
          ? `This action requires "${required}" access, but you only have "${level}" access to this diagram.`
          : 'You do not have access to this diagram.',
      });
    }
  };
}
