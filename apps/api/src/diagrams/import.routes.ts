import type { FastifyInstance, FastifyReply } from 'fastify';
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
  }>('/projects/:projectId/diagrams/import', { preHandler: requireAuth }, async (request, reply) => {
    const { name, dslContent, diagramTypeHint } = request.body;
    if (!name || !dslContent) {
      reply.code(400).send({ error: 'name and dslContent are required' });
      return;
    }
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
  });
}
