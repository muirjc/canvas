import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireProjectAccess } from '../auth/access-control.middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { DslValidationError } from './diagram.service.js';
import { DiagramTypeHintMismatchError, importDiagram, UnrecognizedDslError } from './import.service.js';

function handleImportError(error: unknown, reply: FastifyReply): void {
  if (error instanceof DslValidationError) {
    reply.code(422).send({ error: 'DSL could not be parsed', details: error.errors });
    return;
  }
  if (error instanceof UnrecognizedDslError || error instanceof DiagramTypeHintMismatchError) {
    reply.code(422).send({ error: error.message });
    return;
  }
  throw error;
}

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { projectId: string };
    Body: { name: string; dslContent: string; diagramTypeHint?: string };
  }>(
    '/projects/:projectId/diagrams/import',
    {
      preHandler: [requireAuth, requireProjectAccess('edit', 'projectId')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        body: {
          type: 'object',
          required: ['name', 'dslContent'],
          properties: {
            name: { type: 'string', minLength: 1 },
            dslContent: { type: 'string', minLength: 1 },
            diagramTypeHint: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, dslContent, diagramTypeHint } = request.body;
      try {
        const diagram = await importDiagram({
          name,
          dslContent,
          diagramTypeHint,
          projectId: request.params.projectId,
          ownerId: request.session.user!.id,
        });
        reply.code(201).send({ diagram });
      } catch (error) {
        handleImportError(error, reply);
      }
    },
  );
}
