import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireProjectAccess, requireProjectOwnerOrAdmin } from '../auth/access-control.middleware.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import { resolveProjectAccess } from './project.access.js';
import {
  createProject,
  deleteProject,
  getProject,
  getProjectTree,
  listDeletedProjects,
  listProjectMembers,
  listProjectsForUser,
  NewOwnerNotFoundError,
  transferProjectOwnership,
  ProjectCycleError,
  ProjectHasContentError,
  ProjectNotFoundError,
  ProjectRetentionExpiredError,
  renameProject,
  restoreProject,
} from './project.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof ProjectNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof ProjectCycleError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof ProjectHasContentError || error instanceof ProjectRetentionExpiredError) {
    return reply.code(409).send({ error: error.message });
  }
  throw error;
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { name: string; parentProjectId?: string } }>(
    '/projects',
    {
      // canvas-2h2w.1: viewers are capped at Comment everywhere, so a project they created would be
      // one they couldn't add to. Creating projects is for architects and admins.
      preHandler: requireRole('architect', 'admin'),
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Projects'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1 }, parentProjectId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { name, parentProjectId } = request.body;
      try {
        const project = await createProject({ name, parentProjectId, ownerId: request.session.user!.id });
        return reply.code(201).send({ project });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  /**
   * The projects available to the caller (feature 007, FR-013a). An empty list is a 200, not a
   * 404 — "you have access to no projects" is the first-run path, not an error.
   */
  app.get(
    '/projects',
    { preHandler: requireAuth, schema: { tags: ['Projects'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      return reply.send({ projects: await listProjectsForUser(request.session.user!.id) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/projects/:id',
    {
      preHandler: [requireAuth, requireProjectAccess('view', 'id')],
      schema: { tags: ['Projects'], security: [{ cookieAuth: [] }] },
    },
    async (request, reply) => {
      try {
        return reply.send({ project: await getProject(request.params.id) });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/projects/:id/tree',
    {
      preHandler: [requireAuth, requireProjectAccess('view', 'id')],
      schema: { tags: ['Projects'], security: [{ cookieAuth: [] }] },
    },
    async (request, reply) => {
      try {
        return reply.send({ tree: await getProjectTree(request.params.id) });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/projects/:id',
    {
      preHandler: [requireAuth, requireProjectOwnerOrAdmin()],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Projects'],
        security: [{ cookieAuth: [] }],
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } },
      },
    },
    async (request, reply) => {
      const { name } = request.body;
      try {
        const project = await renameProject(request.params.id, name);
        return reply.send({ project });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  // canvas-2h2w.2: the project's owner and members, for the Members dialog. Anyone who can read
  // the project (everyone signed in) can see who's in it; `yourAccess` says whether they may manage.
  app.get<{ Params: { id: string } }>(
    '/projects/:id/members',
    { preHandler: [requireAuth, requireProjectAccess('view', 'id')], schema: { tags: ['Projects'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        const members = await listProjectMembers(request.params.id);
        const yourAccess = await resolveProjectAccess(request.session.user!.id, request.params.id);
        return reply.send({ ...members, yourAccess });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  // canvas-2h2w.2: hand the project to someone else -- its owner or an admin only. The previous
  // owner stays on as a Manage member.
  app.post<{ Params: { id: string }; Body: { newOwnerId: string } }>(
    '/projects/:id/owner',
    {
      preHandler: [requireAuth, requireProjectOwnerOrAdmin()],
      schema: {
        tags: ['Projects'],
        security: [{ cookieAuth: [] }],
        body: { type: 'object', required: ['newOwnerId'], properties: { newOwnerId: { type: 'string', minLength: 1 } } },
      },
    },
    async (request, reply) => {
      try {
        const previousOwner = await transferProjectOwnership(request.params.id, request.body.newOwnerId, request.session.user!.id);
        if (previousOwner) {
          await recordAudit({
            event: 'project_owner_transferred',
            actorUserId: request.session.user!.id,
            targetUserId: request.body.newOwnerId,
            ip: clientIp(request),
            detail: { projectId: request.params.id, from: previousOwner },
          });
        }
        return reply.send(await listProjectMembers(request.params.id));
      } catch (error) {
        if (error instanceof NewOwnerNotFoundError) return reply.code(400).send({ error: error.message });
        return handleServiceError(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/projects/:id',
    {
      preHandler: [requireAuth, requireProjectOwnerOrAdmin()],
      schema: { tags: ['Projects'], security: [{ cookieAuth: [] }] },
    },
    async (request, reply) => {
      try {
        await deleteProject(request.params.id, request.session.user!.id);
        return reply.code(204).send();
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.get(
    '/admin/deleted-projects',
    { preHandler: requireRole('admin'), schema: { tags: ['Projects'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => {
      return reply.send({ projects: await listDeletedProjects() });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/projects/:id/restore',
    { preHandler: requireRole('admin'), schema: { tags: ['Projects'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        await restoreProject(request.params.id, request.session.user!.id);
        const project = await getProject(request.params.id);
        return reply.send({ project });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );
}
