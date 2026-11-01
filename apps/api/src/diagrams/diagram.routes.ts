import type { FastifyInstance, FastifyReply } from 'fastify';
import { heartbeat, leave, HEARTBEAT_SECONDS } from './presence.service.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  requireDiagramAccess,
  requireDiagramOwnerOrAdmin,
  requireProjectAccess,
} from '../auth/access-control.middleware.js';
import { projectExists, resolveProjectAccess } from '../projects/project.access.js';
import { accessAtLeast, resolveDiagramAccess } from '../sharing/sharing.service.js';
import {
  createDiagram,
  deleteDiagram,
  DiagramNotFoundError,
  DiagramRetentionExpiredError,
  DiagramVersionConflictError,
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
import {
  envelope,
  errorResponse,
  listEnvelope,
  noContent,
  objectResponse,
} from '../contract/schemas.js';

// canvas-1bty.8: response shapes (apps/api/src/contract/schemas.ts).
const diagramResponse = (status: 200 | 201 = 200) => ({
  [status]: envelope('diagram', 'Diagram'),
  '4xx': errorResponse,
});
const versionPage = objectResponse({
  versions: { type: 'array', items: { $ref: 'DiagramVersion#' } },
  hasMore: { type: 'boolean' },
});
import {
  DiagramVersionNotFoundError,
  getDiagramVersion,
  getDiagramVersionContent,
  listDiagramVersions,
} from './version.service.js';

function handleServiceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof DslValidationError) {
    return reply.code(422).send({ error: 'DSL could not be parsed', details: error.errors });
  }
  if (error instanceof DiagramNotFoundError || error instanceof DiagramVersionNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof DiagramVersionConflictError) {
    // canvas-obp0: the editor shows who saved and when, and offers to load theirs or save anyway.
    return reply
      .code(409)
      .send({ error: error.message, code: 'version_conflict', details: error.conflict });
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
    Body: { name: string; diagramTypeId: string; initialDslContent?: string; draft?: boolean };
  }>(
    '/projects/:projectId/diagrams',
    {
      preHandler: [requireAuth, requireProjectAccess('edit', 'projectId')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: diagramResponse(201),
        body: {
          type: 'object',
          required: ['name', 'diagramTypeId'],
          properties: {
            name: { type: 'string', minLength: 1 },
            diagramTypeId: { type: 'string', minLength: 1 },
            initialDslContent: { type: 'string' },
            // canvas-j6v: Create with AI -- unsaved and hidden until the creator saves it.
            draft: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, diagramTypeId, initialDslContent, draft } = request.body;
      // canvas-1bty.18: the access check lets a missing project through for this 404 (it used to hit
      // the foreign key, a 500; a deleted project would have taken the diagram).
      if (!(await projectExists(request.params.projectId))) {
        return reply.code(404).send({ error: `No project with id ${request.params.projectId}` });
      }
      try {
        const diagram = await createDiagram({
          name,
          diagramTypeId,
          projectId: request.params.projectId,
          ownerId: request.session.user!.id,
          initialDslContent,
          draft,
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
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: { 200: listEnvelope('diagrams', 'DiagramSummary'), '4xx': errorResponse },
      },
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
      schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }], response: diagramResponse() },
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

  app.patch<{ Params: { id: string }; Body: { dslContent: string; baseVersionId: string } }>(
    '/diagrams/:id',
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: diagramResponse(),
        // canvas-obp0: baseVersionId is the version the editor started from (the diagram's
        // currentVersionId when loaded or last saved). 409 if another save has replaced it since.
        body: {
          type: 'object',
          required: ['dslContent', 'baseVersionId'],
          properties: {
            dslContent: { type: 'string' },
            baseVersionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { dslContent, baseVersionId } = request.body;
      try {
        const diagram = await saveDiagram(request.params.id, {
          dslContent,
          authorId: request.session.user!.id,
          baseVersionId,
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
        response: diagramResponse(),
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
        response: diagramResponse(),
        body: {
          type: 'object',
          required: ['description'],
          properties: { description: { type: 'string' } },
        },
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
        response: diagramResponse(),
        body: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string', minLength: 1 } },
        },
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

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; q?: string; from?: string; to?: string };
  }>(
    '/diagrams/:id/versions',
    {
      preHandler: [requireAuth, requireDiagramAccess('view')],
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: { 200: versionPage, '4xx': errorResponse },
        // canvas-zfe: from/to are instants (ISO 8601) the browser computes from a typed date in
        // the user's own time zone.
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'string' },
            q: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const parsedLimit = Number.parseInt(request.query.limit ?? '', 10);
      const page = await listDiagramVersions(request.params.id, {
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        search: request.query.q,
        from: request.query.from ? new Date(request.query.from) : undefined,
        to: request.query.to ? new Date(request.query.to) : undefined,
      });
      return reply.send(page);
    },
  );

  // canvas-3fha: one version with its content, for the read-only preview in History.
  app.get<{ Params: { id: string; versionId: string } }>(
    '/diagrams/:id/versions/:versionId',
    {
      preHandler: [requireAuth, requireDiagramAccess('view')],
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: { 200: envelope('version', 'DiagramVersion'), '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      try {
        return reply.send({
          version: await getDiagramVersion(request.params.id, request.params.versionId),
        });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; versionId: string }; Body: { baseVersionId: string } }>(
    '/diagrams/:id/versions/:versionId/restore',
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      // canvas-obp0: restoring on top of someone else's newer save is a conflict too.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: diagramResponse(),
        body: {
          type: 'object',
          required: ['baseVersionId'],
          properties: { baseVersionId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      try {
        const restoredContent = await getDiagramVersionContent(
          request.params.id,
          request.params.versionId,
        );
        const diagram = await saveDiagram(request.params.id, {
          dslContent: restoredContent,
          authorId: request.session.user!.id,
          restoredFromVersionId: request.params.versionId,
          baseVersionId: request.body.baseVersionId,
        });
        return reply.send({ diagram });
      } catch (error) {
        return handleServiceError(error, reply);
      }
    },
  );

  // canvas-obp0: presence. The editor heartbeats while it is open (edit access only: viewers aren't
  // editors) and gets back everyone else who has the diagram open, for the "also editing" banner.
  const sessionBody = {
    type: 'object',
    required: ['sessionId'],
    properties: { sessionId: { type: 'string', minLength: 1, maxLength: 100 } },
  } as const;

  app.put<{ Params: { id: string }; Body: { sessionId: string } }>(
    '/diagrams/:id/presence',
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: {
          200: objectResponse({
            others: { type: 'array', items: { $ref: 'OtherEditor#' } },
            heartbeatSeconds: { type: 'integer' },
          }),
          '4xx': errorResponse,
        },
        body: sessionBody,
      },
    },
    async (request, reply) => {
      const others = await heartbeat(
        request.params.id,
        request.session.user!.id,
        request.body.sessionId,
      );
      return reply.send({ others, heartbeatSeconds: HEARTBEAT_SECONDS });
    },
  );

  app.post<{ Params: { id: string }; Body: { sessionId: string } }>(
    '/diagrams/:id/presence/leave',
    {
      preHandler: [requireAuth, requireDiagramAccess('edit')],
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: { 204: noContent, '4xx': errorResponse },
        body: sessionBody,
      },
    },
    async (request, reply) => {
      await leave(request.params.id, request.session.user!.id, request.body.sessionId);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/diagrams/:id',
    {
      preHandler: [requireAuth, requireDiagramOwnerOrAdmin()],
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: { 204: noContent, '4xx': errorResponse },
      },
    },
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
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        response: {
          200: objectResponse({
            diagrams: { type: 'array', items: { $ref: 'DeletedDiagram#' } },
            hasMore: { type: 'boolean' },
          }),
          '4xx': errorResponse,
        },
      },
    },
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
    {
      preHandler: requireRole('admin'),
      schema: { tags: ['Diagrams'], security: [{ cookieAuth: [] }], response: diagramResponse() },
    },
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
