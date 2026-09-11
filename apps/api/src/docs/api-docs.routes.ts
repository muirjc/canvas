import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

/**
 * OpenAPI/Swagger spec + interactive UI, gated behind config.enableApiDocs (app.ts) -- opt-in,
 * same posture as allowLocalAuth, so the public Azure deployment doesn't expose its full route
 * surface by default just because this repo added the capability.
 *
 * Registered BEFORE every other route (app.ts's own registration order) -- @fastify/swagger
 * builds its document by inspecting each route as it's added, so routes registered before this
 * plugin would be invisible to it (its own documented gotcha, not assumed).
 *
 * Foundational pass: lists every real route (Fastify's own introspection needs no per-route
 * schema to do that). canvas-lfc's own follow-up pass gave every route a `tags`/`security`
 * declaration (grouped by resource below, cookieAuth referenced wherever a preHandler actually
 * enforces it) -- so /docs's sidebar is now organized and each operation shows whether it needs
 * auth. Request/response body/params schemas remain only partially filled in (canvas-80m added
 * them to routes that had hand-rolled validation to convert; every route's full body/response
 * shape is a further, separate pass, deliberately not attempted here) -- see the route source
 * under apps/api/src/**\/*.routes.ts and its matching apps/api/tests/contract/*.test.ts for the
 * authoritative shape of any endpoint not yet schema-annotated.
 */
export async function registerApiDocsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Canvas API',
        description:
          'REST API for the Canvas diagramming platform (Mermaid DSL parser/serializer, ' +
          'diagram/project/sharing/standards CRUD, AI-assisted chat, admin console). ' +
          'Route bodies/responses are largely undocumented in this pass -- see the route source ' +
          'under apps/api/src/**/*.routes.ts and its matching apps/api/tests/contract/*.test.ts ' +
          'for the authoritative request/response shape of any endpoint not yet schema-annotated.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            // @fastify/session's own default cookie name (session.ts registers no `cookieName`
            // override) -- every authenticated route reads request.session.user, set by either
            // POST /auth/local/login or the OIDC callback (GET /auth/callback).
            name: 'sessionId',
          },
        },
      },
      // canvas-lfc: grouped by resource, one tag per *.routes.ts file (or a natural sub-split
      // within one, e.g. Users out of admin/user-lookup.routes.ts, since it's not admin-gated)
      // -- gives /docs's sidebar real structure instead of one flat, undifferentiated route list.
      tags: [
        { name: 'Auth', description: 'Local/OIDC login, session info, sign-out.' },
        { name: 'Health', description: 'Liveness check.' },
        { name: 'Projects', description: 'Project CRUD, tree, soft-delete/restore.' },
        { name: 'Diagrams', description: 'Diagram CRUD, versions, move, soft-delete/restore.' },
        { name: 'DiagramTypes', description: 'The built-in DiagramType catalog.' },
        { name: 'Export', description: 'Rendering a diagram to Mermaid/SVG/PNG.' },
        { name: 'Sharing', description: 'Per-diagram/project share grants.' },
        { name: 'Standards', description: 'Per-diagram-type governance rules (draft/publish/retire).' },
        { name: 'Libraries', description: 'Icon/shape library ingestion and search.' },
        { name: 'AI', description: 'AI chat, personas, reference material, and the chat feature flag.' },
        { name: 'Admin', description: 'Admin-only user management and platform overview.' },
        { name: 'Users', description: 'Non-admin-gated user lookup (e.g. for sharing).' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });
}
