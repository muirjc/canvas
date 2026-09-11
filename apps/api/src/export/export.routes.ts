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

// jmuir-dzd.5 appsec review: the web app's own ExportMenu already forces a download via a
// synthetic <a download> click (never a direct browser navigation), but this route has no such
// guarantee for a caller who bookmarks/shares/curls the URL directly (view access is all
// requireDiagramAccess needs, so this reaches every viewer of a shared diagram too) -- with no
// Content-Disposition at all, a direct GET renders the SVG (or, after jmuir-dzd.5, an SVG whose
// node carries a click href) INLINE at this API's own origin, tightening any XSS-class bug in the
// SVG's own content into a same-origin exposure with no extra step. Forcing a download closes
// that regardless of what the SVG contains -- defense in depth, not a substitute for the SVG's
// own content-level protections (isAllowedLinkHref/escapeXml). A fixed, non-diagram-derived
// filename is used deliberately (not the diagram's own possibly-attacker-influenced name) so this
// header can't become a second injection surface of its own.
const CONTENT_DISPOSITIONS: Record<string, string> = {
  mermaid: 'attachment; filename="diagram.mmd"',
  svg: 'attachment; filename="diagram.svg"',
  png: 'attachment; filename="diagram.png"',
};

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/diagrams/:id/export',
    {
      preHandler: [requireAuth, requireDiagramAccess('view')],
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        querystring: {
          type: 'object',
          properties: { format: { type: 'string', enum: ['mermaid', 'svg', 'png'] } },
        },
      },
    },
    async (request, reply) => {
      const format = request.query.format ?? 'mermaid';

      try {
        const diagram = await getDiagram(request.params.id);
        const dslFamilyId = await loadDiagramTypeDslFamily(diagram.diagramTypeId);

        reply.header('Content-Type', CONTENT_TYPES[format]);
        reply.header('Content-Disposition', CONTENT_DISPOSITIONS[format]);
        if (format === 'mermaid') {
          reply.send(exportMermaid(diagram.dslContent));
        } else if (format === 'svg') {
          reply.send(await exportSvg(dslFamilyId, diagram.dslContent));
        } else {
          reply.send(await exportPng(dslFamilyId, diagram.dslContent));
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
