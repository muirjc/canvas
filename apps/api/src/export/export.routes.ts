import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { requireDiagramAccess } from '../auth/access-control.middleware.js';
import { DiagramNotFoundError, getDiagram, loadDiagramTypeDslFamily } from '../diagrams/diagram.service.js';
import { exportMermaid, exportPng, exportSvg, UnrenderableDiagramError } from './export.service.js';

const CONTENT_TYPES: Record<string, string> = {
  mermaid: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
};

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/diagrams/:id/export',
    { preHandler: [requireAuth, requireDiagramAccess('view')] },
    async (request, reply) => {
      const format = request.query.format ?? 'mermaid';
      if (!['mermaid', 'svg', 'png'].includes(format)) {
        reply.code(400).send({ error: 'format must be one of: mermaid, svg, png' });
        return;
      }

      try {
        const diagram = await getDiagram(request.params.id);
        const dslFamilyId = await loadDiagramTypeDslFamily(diagram.diagramTypeId);

        reply.header('Content-Type', CONTENT_TYPES[format]);
        if (format === 'mermaid') {
          reply.send(exportMermaid(diagram.dslContent));
        } else if (format === 'svg') {
          reply.send(exportSvg(dslFamilyId, diagram.dslContent));
        } else {
          reply.send(exportPng(dslFamilyId, diagram.dslContent));
        }
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          reply.code(404).send({ error: error.message });
          return;
        }
        if (error instanceof UnrenderableDiagramError) {
          reply.code(422).send({ error: error.message });
          return;
        }
        throw error;
      }
    },
  );
}
