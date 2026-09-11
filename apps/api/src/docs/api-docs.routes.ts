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
 * Foundational pass only: lists every real route (Fastify's own introspection needs no per-route
 * schema to do that), but request/response bodies/params stay undocumented until individual
 * routes gain a `schema` option -- adding that to all ~16 route files' worth of endpoints is a
 * much larger, separate pass (filed as canvas-lfc), not attempted here. A cookieAuth security
 * scheme is still declared below so the one real auth mechanism this API has is at least named,
 * even before any route opts into declaring `security: [{ cookieAuth: [] }]` for itself.
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
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });
}
