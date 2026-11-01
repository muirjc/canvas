import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { errorResponse } from '../contract/schemas.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import { getAppSettings, setAppSettings, type AppSettings } from './app-settings.service.js';

/** canvas-8em: admin-controlled feature switches. Any signed-in user reads them (the client hides
 *  what's switched off); only an admin changes them, and each change is audited. */
export async function registerAppSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/app-settings',
    { preHandler: requireAuth, schema: { tags: ['Settings'], security: [{ cookieAuth: [] }], response: { 200: { $ref: 'AppSettings#' }, '4xx': errorResponse } } },
    async (_request, reply) => {
      return reply.send(await getAppSettings());
    },
  );

  app.patch<{ Body: Partial<AppSettings> }>(
    '/admin/app-settings',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Settings'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          minProperties: 1,
          properties: { sharingEnabled: { type: 'boolean' } },
          additionalProperties: false,
        },
        response: { 200: { $ref: 'AppSettings#' }, '4xx': errorResponse },
      },
    },
    async (request, reply) => {
      // Unknown keys are stripped by validation (Fastify removeAdditional), so a body naming no
      // known setting arrives empty here.
      if (Object.keys(request.body).length === 0) return reply.code(400).send({ error: 'No known setting to change.' });
      const before = await getAppSettings();
      const after = await setAppSettings(request.body);
      for (const setting of Object.keys(request.body) as (keyof AppSettings)[]) {
        if (before[setting] === after[setting]) continue;
        await recordAudit({
          event: 'app_setting_changed',
          actorUserId: request.session.user?.id,
          ip: clientIp(request),
          detail: { setting, from: before[setting], to: after[setting] },
        });
      }
      return reply.send(after);
    },
  );
}
