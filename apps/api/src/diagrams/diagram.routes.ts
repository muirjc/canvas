import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requireDiagramAccess, requireDiagramOwnerOrAdmin, requireProjectAccess } from '../auth/access-control.middleware.js';
import { projectExists, resolveProjectAccess } from '../projects/project.access.js';
import { accessAtLeast, resolveDiagramAccess } from '../sharing/sharing.service.js';
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
  updateDiagramDescription,
  UnknownDiagramTypeError,
} from './diagram.service.js';
import { searchDiagrams } from './search.service.js';
import { DiagramVersionNotFoundError, getDiagramVersionContent, listDiagramVersions } from './version.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof DslValidationError) {
    return reply.code(422).send({ error: 'DSL could not be parsed', details: error.errors });
  }
  if (error instanceof DiagramNotFoundError || error instanceof DiagramVersionNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof DiagramRetentionExpiredError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof UnknownDiagramTypeError) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

export async function registerDiagramRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { projectId: string };
    Body: { name: string; diagramTypeId: string; initialDslContent?: string };
  }>(
    '/projects/:projectId/diagrams',
    {
      preHandler: [requireAuth, requireProjectAccess('edit', 'projectId')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['name', 'diagramTypeId'],
          properties: {
            name: { type: 'string', minLength: 1 },
            diagramTypeId: { type: 'string', minLength: 1 },
            initialDslContent: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, diagramTypeId, initialDslContent } = request.body;
      try {
        const diagram = await createDiagram({
          name,
          diagramTypeId,
          projectId: request.params.projectId,
          ownerId: request.session.user!.id,
          initialDslContent,
        });
        return reply.code(201).send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { query?: string; type?: string } }>(
    '/projects/:projectId/diagrams',
    {
      preHandler: [requireAuth, requireProjectAccess('view', 'projectId')],
      schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }] },
    },
    async (request, reply) => {
      const diagrams = await searchDiagrams({
        projectId: request.params.projectId,
        query: request.query.query,
        diagramTypeId: request.query.type,
      });
      return reply.send({ diagrams });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/diagrams/:id',
    {
      preHandler: [requireAuth, requireDiagramAccess('view')],
      schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }] },
    },
    async (request, reply) => {
      try {
        const diagram = await getDiagram(request.params.id);
        // canvas-bw4: the caller's own access, so the editor knows whether they may comment/edit.
        const accessLevel = await resolveDiagramAccess(request.session.user!.id, request.params.id);
        return reply.send({ diagram: { ...diagram, accessLevel } });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { dslContent: string } }>(
    '/diagrams/:id',
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        body: { type: 'object', required: ['dslContent'], properties: { dslContent: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { dslContent } = request.body;
      try {
        const diagram = await saveDiagram(request.params.id, {
          dslContent,
          authorId: request.session.user!.id,
        });
        return reply.send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
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
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if` --
      // the pattern rejects whitespace-only strings, which minLength alone would not catch.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, pattern: '\\S' } },
        },
      },
    },
    async (request, reply) => {
      const { name } = request.body;
      try {
        const diagram = await renameDiagram(request.params.id, name);
        return reply.send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  /**
   * Sets a diagram's free-text description (canvas-hbk). Same access bar as renaming — edit
   * access is enough, no owner-or-admin restriction — and unlike name, an empty string is a
   * valid value (clears it back to "none set"), not rejected.
   */
  app.patch<{ Params: { id: string }; Body: { description: string } }>(
    '/diagrams/:id/description',
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if` --
      // deliberately no minLength, since an empty string is a valid value (clears the description).
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        body: { type: 'object', required: ['description'], properties: { description: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const { description } = request.body;
      try {
        const diagram = await updateDiagramDescription(request.params.id, description);
        return reply.send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
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
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        body: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', minLength: 1 } } },
      },
    },
    async (request, reply) => {
      const { projectId } = request.body;
      if (!(await projectExists(projectId))) {
        return reply.code(404).send({ error: `No project with id ${projectId}` });
      }
      const level = await resolveProjectAccess(request.session.user!.id, projectId);
      if (!accessAtLeast(level, 'edit')) {
        return reply.code(403).send({
          error: level
            ? `This action requires "edit" access, but you only have "${level}" access to the destination project.`
            : 'You do not have access to the destination project.',
        });
      }
      try {
        const diagram = await moveDiagram(request.params.id, projectId);
        return reply.send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; q?: string } }>(
    '/diagrams/:id/versions',
    { preHandler: [requireAuth, requireDiagramAccess('view')], schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const parsedLimit = Number.parseInt(request.query.limit ?? '', 10);
      const page = await listDiagramVersions(request.params.id, {
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        search: request.query.q,
      });
      return reply.send(page);
    },
  );

  app.post<{ Params: { id: string; versionId: string } }>(
    '/diagrams/:id/versions/:versionId/restore',
    { preHandler: [requireAuth, requireDiagramAccess('edit')], schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        const restoredContent = await getDiagramVersionContent(request.params.id, request.params.versionId);
        const diagram = await saveDiagram(request.params.id, {
          dslContent: restoredContent,
          authorId: request.session.user!.id,
        });
        return reply.send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/diagrams/:id',
    { preHandler: [requireAuth, requireDiagramOwnerOrAdmin()], schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        await deleteDiagram(request.params.id, request.session.user!.id);
        return reply.code(204).send();
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.get<{ Querystring: { limit?: string; q?: string } }>(
    '/admin/deleted-diagrams',
    { preHandler: requireRole('admin'), schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const parsedLimit = Number.parseInt(request.query.limit ?? '', 10);
      const page = await listDeletedDiagrams({
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        search: request.query.q,
      });
      return reply.send(page);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/restore',
    { preHandler: requireRole('admin'), schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      try {
        await restoreDiagram(request.params.id, request.session.user!.id);
        const diagram = await getDiagram(request.params.id);
        return reply.send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );
}
