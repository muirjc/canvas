import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { requireDiagramAccess, requireProjectAccess } from '../auth/access-control.middleware.js';
import { getDb } from '../db/client.js';
import { envelope, errorResponse, idParams, listEnvelope, noContent } from '../contract/schemas.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import { projectExists, resolveProjectAccess } from '../projects/project.access.js';
import {
  accessAtLeast,
  resolveDiagramAccess,
  createShareGrant,
  GranteeNotFoundError,
  listShareGrants,
  listSharedDiagramsForUser,
  revokeShareGrant,
  ShareGrantNotFoundError,
  type AccessLevel,
  type SubjectType,
} from './sharing.service.js';

/** canvas-2h2w.2: what it takes to add, change or remove access: Manage for a project's members,
 *  Edit for a single diagram's shares. */
const MANAGE_LEVEL: Record<SubjectType, AccessLevel> = { project: 'manage', diagram: 'edit' };

/** canvas-2h2w.1: Manage (Edit + managing members) is a project level; a diagram share stops at Edit. */
const VALID_ACCESS_LEVELS: Record<SubjectType, AccessLevel[]> = {
  diagram: ['view', 'comment', 'edit'],
  project: ['view', 'comment', 'edit', 'manage'],
};

function handleError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof GranteeNotFoundError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof ShareGrantNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  throw error;
}

/** A live (not deleted) diagram, or an existing project. */
async function subjectExists(subjectType: SubjectType, id: string): Promise<boolean> {
  if (subjectType === 'project') return projectExists(id);
  const row = await getDb().selectFrom('diagrams').select('id').where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  return Boolean(row);
}

async function accessTo(subjectType: SubjectType, userId: string, id: string): Promise<AccessLevel | undefined> {
  return subjectType === 'project' ? resolveProjectAccess(userId, id) : resolveDiagramAccess(userId, id);
}

/**
 * canvas-i5y: who may do what with shares (decided with the user, option A): sharing and revoking
 * need EDIT access to the diagram/project (owners and admins always have it); seeing the list needs
 * VIEW access. Before this every sharing route only required being signed in, so anyone could give
 * themselves edit access to anything by id.
 */
function requireSubjectAccess(subjectType: SubjectType, required: AccessLevel) {
  return subjectType === 'project' ? requireProjectAccess(required, 'id') : requireDiagramAccess(required);
}

function registerSubjectRoutes(app: FastifyInstance, subjectType: SubjectType): void {
  const basePath = `/${subjectType}s/:id/shares`;
  // The access middleware lets a nonexistent id through (so the route can say 404, not 403).
  const notFound = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!(await subjectExists(subjectType, request.params.id))) {
      return reply.code(404).send({ error: `No ${subjectType} with id ${request.params.id}` });
    }
  };

  app.post<{ Params: { id: string }; Body: { granteeUserId: string; accessLevel: AccessLevel } }>(
    basePath,
    {
      // canvas-2h2w.2: a project's members are managed by its owner, Manage members and admins;
      // a single diagram can still be shared by anyone who can edit it.
      preHandler: [requireAuth, requireSubjectAccess(subjectType, MANAGE_LEVEL[subjectType]), notFound],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if` --
      // applies to both /diagrams/:id/shares and /projects/:id/shares, since both routes are
      // registered by this same shared function.
      schema: {
        tags: ['Sharing'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['granteeUserId', 'accessLevel'],
          properties: {
            granteeUserId: { type: 'string', minLength: 1 },
            accessLevel: { type: 'string', enum: VALID_ACCESS_LEVELS[subjectType] },
          },
        },
        params: idParams,
        response: { 201: envelope('grant', 'ShareGrant'), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      const { granteeUserId, accessLevel } = request.body;
      // Only someone with Manage can hand out Manage, or change someone's existing Manage (an
      // editor can't promote themselves, or demote a manager by re-sharing at a lower level).
      const existing = await getDb()
        .selectFrom('share_grants')
        .select('access_level')
        .where('subject_type', '=', subjectType)
        .where('subject_id', '=', request.params.id)
        .where('grantee_user_id', '=', granteeUserId)
        .executeTakeFirst();
      if (
        (accessLevel === 'manage' || existing?.access_level === 'manage') &&
        !accessAtLeast(await accessTo(subjectType, request.session.user!.id, request.params.id), 'manage')
      ) {
        return reply.code(403).send({ error: 'Only the owner or someone with Manage access can give or change Manage access.' });
      }
      try {
        const grant = await createShareGrant({
          subjectType,
          subjectId: request.params.id,
          granteeUserId,
          accessLevel,
          grantedByUserId: request.session.user!.id,
        });
        if (subjectType === 'project' && existing?.access_level !== accessLevel) {
          await recordAudit({
            event: existing ? 'project_member_changed' : 'project_member_added',
            actorUserId: request.session.user!.id,
            targetUserId: granteeUserId,
            ip: clientIp(request),
            detail: { projectId: request.params.id, level: accessLevel, ...(existing ? { from: existing.access_level } : {}) },
          });
        }
        return reply.code(201).send({ grant });
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    basePath,
    {
      preHandler: [requireAuth, requireSubjectAccess(subjectType, 'view'), notFound],
      schema: { tags: ['Sharing'], security: [{ cookieAuth: [] }], params: idParams, response: { 200: listEnvelope('grants', 'ListedShareGrant'), '4xx': errorResponse } },
    },
    async (request, reply) => {
      return reply.send({ grants: await listShareGrants(subjectType, request.params.id) });
    },
  );
}

export async function registerSharingRoutes(app: FastifyInstance): Promise<void> {
  registerSubjectRoutes(app, 'diagram');
  registerSubjectRoutes(app, 'project');

  /**
   * Diagrams shared directly with the caller (feature 008, FR-001). Self-scoped like
   * GET /projects — no id param, the session names the user. 200 with an empty array for a
   * user with nothing shared; that is the common case, not an error (FR-002).
   */
  app.get(
    '/shared-diagrams',
    {
      preHandler: requireAuth,
      schema: { tags: ['Sharing'], security: [{ cookieAuth: [] }], response: { 200: listEnvelope('diagrams', 'SharedDiagram'), '4xx': errorResponse } },
    },
    async (request, reply) => {
      return reply.send({ diagrams: await listSharedDiagramsForUser(request.session.user!.id) });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/shares/:id',
    {
      preHandler: requireAuth,
      schema: { tags: ['Sharing'], security: [{ cookieAuth: [] }], params: idParams, response: { 204: noContent, '4xx': errorResponse } },
    },
    async (request, reply) => {
      try {
        // canvas-i5y: revoking needs edit access to what the grant is for.
        const grant = await getDb()
          .selectFrom('share_grants')
          .select(['subject_type', 'subject_id', 'access_level', 'grantee_user_id'])
          .where('id', '=', request.params.id)
          .executeTakeFirst();
        if (!grant) return reply.code(404).send({ error: `No share grant with id ${request.params.id}` });
        const level = await accessTo(grant.subject_type, request.session.user!.id, grant.subject_id);
        if (!accessAtLeast(level, MANAGE_LEVEL[grant.subject_type])) {
          return reply.code(403).send({
            error:
              grant.subject_type === 'project'
                ? 'Only the owner or someone with Manage access can remove a member.'
                : 'Only someone with edit access can remove a share.',
          });
        }
        if (grant.access_level === 'manage' && !accessAtLeast(level, 'manage')) {
          return reply.code(403).send({ error: 'Only the owner or someone with Manage access can remove Manage access.' });
        }
        await revokeShareGrant(request.params.id);
        if (grant.subject_type === 'project') {
          await recordAudit({
            event: 'project_member_removed',
            actorUserId: request.session.user!.id,
            targetUserId: grant.grantee_user_id,
            ip: clientIp(request),
            detail: { projectId: grant.subject_id, from: grant.access_level },
          });
        }
        return reply.code(204).send();
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
