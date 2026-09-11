import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import {
  createShareGrant,
  GranteeNotFoundError,
  listShareGrants,
  listSharedDiagramsForUser,
  revokeShareGrant,
  ShareGrantNotFoundError,
  type AccessLevel,
  type SubjectType,
} from './sharing.service.js';

const VALID_ACCESS_LEVELS: AccessLevel[] = ['view', 'comment', 'edit'];

function handleError(error: unknown, reply: FastifyReply): void {
  if (error instanceof GranteeNotFoundError) {
    reply.code(400).send({ error: error.message });
    return;
  }
  if (error instanceof ShareGrantNotFoundError) {
    reply.code(404).send({ error: error.message });
    return;
  }
  throw error;
}

function registerSubjectRoutes(app: FastifyInstance, subjectType: SubjectType): void {
  const basePath = `/${subjectType}s/:id/shares`;

  app.post<{ Params: { id: string }; Body: { granteeUserId: string; accessLevel: AccessLevel } }>(
    basePath,
    {
      preHandler: requireAuth,
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if` --
      // applies to both /diagrams/:id/shares and /projects/:id/shares, since both routes are
      // registered by this same shared function.
      schema: {
        body: {
          type: 'object',
          required: ['granteeUserId', 'accessLevel'],
          properties: {
            granteeUserId: { type: 'string', minLength: 1 },
            accessLevel: { type: 'string', enum: VALID_ACCESS_LEVELS },
          },
        },
      },
    },
    async (request, reply) => {
      const { granteeUserId, accessLevel } = request.body;
      try {
        const grant = await createShareGrant({
          subjectType,
          subjectId: request.params.id,
          granteeUserId,
          accessLevel,
          grantedByUserId: request.session.user!.id,
        });
        reply.code(201).send({ grant });
      } catch (error) {
        handleError(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string } }>(basePath, { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ grants: await listShareGrants(subjectType, request.params.id) });
  });
}

export async function registerSharingRoutes(app: FastifyInstance): Promise<void> {
  registerSubjectRoutes(app, 'diagram');
  registerSubjectRoutes(app, 'project');

  /**
   * Diagrams shared directly with the caller (feature 008, FR-001). Self-scoped like
   * GET /projects — no id param, the session names the user. 200 with an empty array for a
   * user with nothing shared; that is the common case, not an error (FR-002).
   */
  app.get('/shared-diagrams', { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ diagrams: await listSharedDiagramsForUser(request.session.user!.id) });
  });

  app.delete<{ Params: { id: string } }>('/shares/:id', { preHandler: requireAuth }, async (request, reply) => {
    try {
      await revokeShareGrant(request.params.id);
      reply.code(204).send();
    } catch (error) {
      handleError(error, reply);
    }
  });
}
