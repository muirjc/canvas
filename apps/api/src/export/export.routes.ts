import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { requireDiagramAccess } from '../auth/access-control.middleware.js';
import { DiagramNotFoundError, getDiagram, loadDiagramTypeDslFamily } from '../diagrams/diagram.service.js';
import { exportMermaid, exportPng, exportSvg, UnrenderableDiagramError } from './export.service.js';
import { errorResponse, idParams } from '../contract/schemas.js';

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
/** Inline styles only; everything else blocked, and the response gets an opaque, sandboxed origin. */
export const EXPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

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
        tags: ['Export'],
        security: [{ cookieAuth: [] }],
        querystring: {
          type: 'object',
          properties: { format: { type: 'string', enum: ['mermaid', 'svg', 'png'] } },
        },
        params: idParams,
        // canvas-1bty.10: not JSON -- the file itself, by format (with download and CSP headers).
        response: {
          200: {
            description: 'The diagram as Mermaid text, SVG or PNG',
            content: {
              'text/plain': { schema: { type: 'string' } },
              'image/svg+xml': { schema: { type: 'string' } },
              'image/png': { schema: { type: 'string', format: 'binary' } },
            },
          },
          '4xx': errorResponse,
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
        // Defence in depth: an exported file opened straight from this URL can't run anything --
        // no scripts, no loads, a sandboxed origin -- whatever ends up inside the SVG.
        reply.header('Content-Security-Policy', EXPORT_CSP);
        if (format === 'mermaid') {
          return reply.send(exportMermaid(diagram.dslContent));
        } else if (format === 'svg') {
          return reply.send(await exportSvg(dslFamilyId, diagram.dslContent, diagram.diagramTypeId));
        } else {
          return reply.send(await exportPng(dslFamilyId, diagram.dslContent, diagram.diagramTypeId));
        }
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof UnrenderableDiagramError) {
          return reply.code(422).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
