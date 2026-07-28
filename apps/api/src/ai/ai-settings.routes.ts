import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { getAiSettings, setAiSettings } from './ai-settings.service.js';

export async function registerAiSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/ai-settings', { preHandler: requireRole('admin') }, async (_request, reply) => {
    reply.send(await getAiSettings());
  });

  app.patch<{ Body: { chatEnabled: boolean } }>(
    '/admin/ai-settings',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      if (typeof request.body.chatEnabled !== 'boolean') {
        reply.code(400).send({ error: 'chatEnabled must be a boolean' });
        return;
      }
      reply.send(await setAiSettings({ chatEnabled: request.body.chatEnabled }));
    },
  );
}
