import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
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

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  const app = Fastify({
    logger: options.logger ?? {
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
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

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
