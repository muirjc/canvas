import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { LanguageModel } from 'ai';
import { loadConfig, type AppConfig } from './config.js';
import { registerSession } from './auth/session.js';
import { registerOidcRoutes } from './auth/oidc.js';
import { registerLocalAuthRoutes } from './auth/local.js';
import { registerDiagramRoutes } from './diagrams/diagram.routes.js';
import { registerDiagramTypeRoutes } from './diagrams/diagram-type.routes.js';
import { registerImportRoutes } from './diagrams/import.routes.js';
import { registerSharingRoutes } from './sharing/sharing.routes.js';
import { registerAdminRoutes } from './admin/admin.routes.js';
import { registerUserLookupRoutes } from './admin/user-lookup.routes.js';
import { registerExportRoutes } from './export/export.routes.js';
import { registerStandardRoutes } from './standards/standard.routes.js';
import { registerLibraryRoutes } from './libraries/library.routes.js';
import { registerProjectRoutes } from './projects/project.routes.js';
import { registerAiSettingsRoutes } from './ai/ai-settings.routes.js';
import { registerPersonaRoutes } from './ai/persona.routes.js';
import { registerDiagramChatRoutes } from './ai/diagram-chat.routes.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  /** Test injection point (research.md §8) — overrides the AI provider the chat endpoint uses,
   * bypassing apps/api/src/ai/provider.ts's env-based resolution. Production never sets this. */
  languageModel?: LanguageModel;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: options.logger ?? {
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
    // canvas-azure-deploy: most real deployments (Azure App Service among them) terminate TLS at
    // a reverse proxy/load balancer and forward to this process over plain HTTP internally.
    // Without trustProxy, Fastify has no way to know the original request was HTTPS, so a
    // Secure-flagged session cookie (see auth/session.ts) is silently never issued — no error,
    // just a login that "succeeds" but never actually signs the user in on their next request.
    // Harmless with no reverse proxy in front (e.g. local dev): it only takes effect when
    // X-Forwarded-* headers are actually present on the request.
    trustProxy: true,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: statusCode === 500 ? 'Internal server error' : error.message,
    });
  });

  // Only the configured web origin(s) may make credentialed requests — reflecting every
  // origin (the previous `origin: true`) combined with credentials would let any website ride
  // a signed-in user's session cookie.
  await app.register(cors, { origin: config.webOrigins, credentials: true });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
  });
  await registerSession(app, config);
  await registerOidcRoutes(app, config);
  if (config.allowLocalAuth) {
    await registerLocalAuthRoutes(app);
  }
  await registerDiagramRoutes(app);
  await registerDiagramTypeRoutes(app);
  await registerImportRoutes(app);
  await registerSharingRoutes(app);
  await registerAdminRoutes(app);
  await registerUserLookupRoutes(app);
  await registerExportRoutes(app);
  await registerStandardRoutes(app);
  await registerLibraryRoutes(app);
  await registerProjectRoutes(app);
  await registerAiSettingsRoutes(app);
  await registerPersonaRoutes(app);
  await registerDiagramChatRoutes(app, { languageModel: options.languageModel });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
