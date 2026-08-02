import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireProjectAccess, requireProjectOwnerOrAdmin } from '../auth/access-control.middleware.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  createProject,
  deleteProject,
  getProject,
  getProjectTree,
  listDeletedProjects,
  listProjectsForUser,
  ProjectCycleError,
  ProjectHasContentError,
  ProjectNotFoundError,
  ProjectRetentionExpiredError,
  renameProject,
  restoreProject,
} from './project.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): void {
  if (error instanceof ProjectNotFoundError) {
    reply.code(404).send({ error: error.message });
    return;
  }
  if (error instanceof ProjectCycleError) {
    reply.code(400).send({ error: error.message });
    return;
  }
  if (error instanceof ProjectHasContentError || error instanceof ProjectRetentionExpiredError) {
    reply.code(409).send({ error: error.message });
    return;
  }
  throw error;
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { name: string; parentProjectId?: string } }>(
    '/projects',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { name, parentProjectId } = request.body;
      if (!name) {
        reply.code(400).send({ error: 'name is required' });
        return;
      }
      try {
        const project = await createProject({ name, parentProjectId, ownerId: request.session.user!.id });
        reply.code(201).send({ project });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  /**
   * The projects available to the caller (feature 007, FR-013a). An empty list is a 200, not a
   * 404 — "you have access to no projects" is the first-run path, not an error.
   */
  app.get('/projects', { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ projects: await listProjectsForUser(request.session.user!.id) });
  });

  app.get<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: [requireAuth, requireProjectAccess('view', 'id')] },
    async (request, reply) => {
      try {
        reply.send({ project: await getProject(request.params.id) });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/projects/:id/tree',
    { preHandler: [requireAuth, requireProjectAccess('view', 'id')] },
    async (request, reply) => {
      try {
        reply.send({ tree: await getProjectTree(request.params.id) });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/projects/:id',
    { preHandler: [requireAuth, requireProjectOwnerOrAdmin()] },
    async (request, reply) => {
      const { name } = request.body;
      if (!name) {
        reply.code(400).send({ error: 'name is required' });
        return;
      }
      try {
        const project = await renameProject(request.params.id, name);
        reply.send({ project });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: [requireAuth, requireProjectOwnerOrAdmin()] },
    async (request, reply) => {
      try {
        await deleteProject(request.params.id, request.session.user!.id);
        reply.code(204).send();
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.get('/admin/deleted-projects', { preHandler: requireRole('admin') }, async (_request, reply) => {
    reply.send({ projects: await listDeletedProjects() });
  });

  app.post<{ Params: { id: string } }>(
    '/projects/:id/restore',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        await restoreProject(request.params.id, request.session.user!.id);
        const project = await getProject(request.params.id);
        reply.send({ project });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );
}
