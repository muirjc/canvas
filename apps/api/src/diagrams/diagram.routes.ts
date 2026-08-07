import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requireDiagramAccess, requireDiagramOwnerOrAdmin, requireProjectAccess } from '../auth/access-control.middleware.js';
import { projectExists, resolveProjectAccess } from '../projects/project.access.js';
import { accessAtLeast } from '../sharing/sharing.service.js';
import {
  createDiagram,
  deleteDiagram,
  DiagramNotFoundError,
  DiagramRetentionExpiredError,
  DslValidationError,
  getDiagram,
  listDeletedDiagrams,
  moveDiagram,
  renameDiagram,
  restoreDiagram,
  saveDiagram,
  UnknownDiagramTypeError,
} from './diagram.service.js';
import { searchDiagrams } from './search.service.js';
import { DiagramVersionNotFoundError, getDiagramVersionContent, listDiagramVersions } from './version.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): void {
  if (error instanceof DslValidationError) {
    reply.code(422).send({ error: 'DSL could not be parsed', details: error.errors });
    return;
  }
  if (error instanceof DiagramNotFoundError || error instanceof DiagramVersionNotFoundError) {
    reply.code(404).send({ error: error.message });
    return;
  }
  if (error instanceof DiagramRetentionExpiredError) {
    reply.code(409).send({ error: error.message });
    return;
  }
  if (error instanceof UnknownDiagramTypeError) {
    reply.code(400).send({ error: error.message });
    return;
  }
  throw error;
}

export async function registerDiagramRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { projectId: string };
    Body: { name: string; diagramTypeId: string; initialDslContent?: string };
  }>(
    '/projects/:projectId/diagrams',
    { preHandler: [requireAuth, requireProjectAccess('edit', 'projectId')] },
    async (request, reply) => {
      const { name, diagramTypeId, initialDslContent } = request.body;
      if (!name || !diagramTypeId) {
        reply.code(400).send({ error: 'name and diagramTypeId are required' });
        return;
      }
      try {
        const diagram = await createDiagram({
          name,
          diagramTypeId,
          projectId: request.params.projectId,
          ownerId: request.session.user!.id,
          initialDslContent,
        });
        reply.code(201).send({ diagram });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { query?: string; type?: string } }>(
    '/projects/:projectId/diagrams',
    { preHandler: [requireAuth, requireProjectAccess('view', 'projectId')] },
    async (request, reply) => {
      const diagrams = await searchDiagrams({
        projectId: request.params.projectId,
        query: request.query.query,
        diagramTypeId: request.query.type,
      });
      reply.send({ diagrams });
    },
  );

  app.get<{ Params: { id: string } }>('/diagrams/:id', { preHandler: [requireAuth, requireDiagramAccess('view')] }, async (request, reply) => {
    try {
      const diagram = await getDiagram(request.params.id);
      reply.send({ diagram });
    } catch (error) {
      handleServiceError(error, reply);
    }
  });

  app.patch<{ Params: { id: string }; Body: { dslContent: string } }>(
    '/diagrams/:id',
    { preHandler: [requireAuth, requireDiagramAccess('edit')] },
    async (request, reply) => {
      const { dslContent } = request.body;
      if (typeof dslContent !== 'string') {
        reply.code(400).send({ error: 'dslContent is required' });
        return;
      }
      try {
        const diagram = await saveDiagram(request.params.id, {
          dslContent,
          authorId: request.session.user!.id,
        });
        reply.send({ diagram });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  /**
   * Renames a diagram (canvas-8x1). Edit access is enough — unlike renaming a project
   * (requireProjectOwnerOrAdmin), a diagram's name is just another editable field, the same bar
   * as PATCH /diagrams/:id's dslContent above.
   */
  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/diagrams/:id/name',
    { preHandler: [requireAuth, requireDiagramAccess('edit')] },
    async (request, reply) => {
      const { name } = request.body;
      if (!name || !name.trim()) {
        reply.code(400).send({ error: 'name is required' });
        return;
      }
      try {
        const diagram = await renameDiagram(request.params.id, name);
        reply.send({ diagram });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  /**
   * Moves a diagram to a different project (canvas-228.3). Two resources need checking, which no
   * existing preHandler covers in one shot: `requireDiagramAccess('edit')` guards the diagram (the
   * :id param), then the destination project id — which arrives in the body, not a route param —
   * is checked by hand here, the same rule `requireProjectAccess` enforces but for a param name
   * that middleware has no way to see (it's not part of this route's own params).
   */
  app.patch<{ Params: { id: string }; Body: { projectId: string } }>(
    '/diagrams/:id/project',
    { preHandler: [requireAuth, requireDiagramAccess('edit')] },
    async (request, reply) => {
      const { projectId } = request.body;
      if (!projectId) {
        reply.code(400).send({ error: 'projectId is required' });
        return;
      }
      if (!(await projectExists(projectId))) {
        reply.code(404).send({ error: `No project with id ${projectId}` });
        return;
      }
      const level = await resolveProjectAccess(request.session.user!.id, projectId);
      if (!accessAtLeast(level, 'edit')) {
        reply.code(403).send({
          error: level
            ? `This action requires "edit" access, but you only have "${level}" access to the destination project.`
            : 'You do not have access to the destination project.',
        });
        return;
      }
      try {
        const diagram = await moveDiagram(request.params.id, projectId);
        reply.send({ diagram });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; q?: string } }>(
    '/diagrams/:id/versions',
    { preHandler: [requireAuth, requireDiagramAccess('view')] },
    async (request, reply) => {
      const parsedLimit = Number.parseInt(request.query.limit ?? '', 10);
      const page = await listDiagramVersions(request.params.id, {
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        search: request.query.q,
      });
      reply.send(page);
    },
  );

  app.post<{ Params: { id: string; versionId: string } }>(
    '/diagrams/:id/versions/:versionId/restore',
    { preHandler: [requireAuth, requireDiagramAccess('edit')] },
    async (request, reply) => {
      try {
        const restoredContent = await getDiagramVersionContent(request.params.id, request.params.versionId);
        const diagram = await saveDiagram(request.params.id, {
          dslContent: restoredContent,
          authorId: request.session.user!.id,
        });
        reply.send({ diagram });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/diagrams/:id',
    { preHandler: [requireAuth, requireDiagramOwnerOrAdmin()] },
    async (request, reply) => {
      try {
        await deleteDiagram(request.params.id, request.session.user!.id);
        reply.code(204).send();
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Querystring: { limit?: string; q?: string } }>(
    '/admin/deleted-diagrams',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const parsedLimit = Number.parseInt(request.query.limit ?? '', 10);
      const page = await listDeletedDiagrams({
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        search: request.query.q,
      });
      reply.send(page);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/restore',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      try {
        await restoreDiagram(request.params.id, request.session.user!.id);
        const diagram = await getDiagram(request.params.id);
        reply.send({ diagram });
      } catch (error) {
        handleServiceError(error, reply);
      }
    },
  );
}
