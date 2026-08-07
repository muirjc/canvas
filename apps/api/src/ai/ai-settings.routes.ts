import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { getAiSettings, setAiSettings } from './ai-settings.service.js';

export async function registerAiSettingsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * canvas-wuc: any authenticated user, not just admins — the AI entry points this gates
   * (the "Create with AI" button, the Chat panel) are used by every architect, not only admins,
   * and need to check `chatEnabled`/`provider` client-side before the user can even start typing,
   * not just receive a 503 after the fact. Mirrors the existing `/ai-personas` (any user, read
   * only) vs `/admin/ai-personas` (admin, full CRUD) split — read-only here too; writing stays
   * admin-only below.
   */
  app.get('/ai-settings', { preHandler: requireAuth }, async (_request, reply) => {
    reply.send(await getAiSettings());
  });

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
