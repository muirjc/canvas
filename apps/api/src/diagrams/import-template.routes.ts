import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireProjectAccess } from '../auth/access-control.middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { DslValidationError } from './diagram.service.js';
import { importTemplate, UnsupportedTemplateTypeError } from './import-template.service.js';

function handleImportTemplateError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof DslValidationError) {
    return reply.code(422).send({ error: 'Template could not be compiled', details: error.errors });
  }
  if (error instanceof UnsupportedTemplateTypeError) {
    return reply.code(422).send({ error: error.message });
  }
  throw error;
}

export async function registerImportTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Params: { projectId: string };
    Body: { name: string; diagramTypeId: string; templateContent: string };
  }>(
    '/projects/:projectId/diagrams/import-template',
    {
      preHandler: [requireAuth, requireProjectAccess('edit', 'projectId')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['Diagrams'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['name', 'diagramTypeId', 'templateContent'],
          properties: {
            name: { type: 'string', minLength: 1 },
            diagramTypeId: { type: 'string', minLength: 1 },
            templateContent: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, diagramTypeId, templateContent } = request.body;
      try {
        const diagram = await importTemplate({
          name,
          diagramTypeId,
          templateContent,
          projectId: request.params.projectId,
          ownerId: request.session.user!.id,
        });
        return reply.code(201).send({ diagram });
      } catch (error) {
        return handleImportTemplateError(error, reply);
      }
    },
  );
}
