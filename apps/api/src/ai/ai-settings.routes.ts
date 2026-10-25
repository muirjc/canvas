import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import { getAiSettings, setAiSettings } from './ai-settings.service.js';
import { AiModelListError, listAiModels } from './ai-models.service.js';

export interface AiSettingsRouteOptions {
  /** canvas-tj1: test injection point for the provider's list-models call. */
  aiFetch?: typeof fetch;
}

export async function registerAiSettingsRoutes(app: FastifyInstance, options: AiSettingsRouteOptions = {}): Promise<void> {
  const fetchImpl = options.aiFetch ?? fetch;

  // canvas-tj1: the models the configured provider offers, for the admin's picker.
  app.get('/admin/ai-models', { preHandler: requireRole('admin'), schema: { tags: ['AI'], security: [{ cookieAuth: [] }] } }, async (request, reply) => {
    const settings = await getAiSettings();
    try {
      const models = await listAiModels(process.env, fetchImpl);
      return reply.send({ provider: settings.provider, models, modelId: settings.modelId, defaultModelId: settings.defaultModelId });
    } catch (error) {
      if (!(error instanceof AiModelListError)) throw error;
      request.log.warn({ message: error.message }, 'listing AI models failed');
      return reply.send({ provider: settings.provider, models: [], modelId: settings.modelId, defaultModelId: settings.defaultModelId, error: error.message });
    }
  });

  /**
   * canvas-wuc: any authenticated user, not just admins — the AI entry points this gates
   * (the "Create with AI" button, the Chat panel) are used by every architect, not only admins,
   * and need to check `chatEnabled`/`provider` client-side before the user can even start typing,
   * not just receive a 503 after the fact. Mirrors the existing `/ai-personas` (any user, read
   * only) vs `/admin/ai-personas` (admin, full CRUD) split — read-only here too; writing stays
   * admin-only below.
   */
  app.get(
    '/ai-settings',
    { preHandler: requireAuth, schema: { tags: ['AI'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => {
      return reply.send(await getAiSettings());
    },
  );

  app.get(
    '/admin/ai-settings',
    { preHandler: requireRole('admin'), schema: { tags: ['AI'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => {
      return reply.send(await getAiSettings());
    },
  );

  app.patch<{ Body: { chatEnabled?: boolean; showUsageToUsers?: boolean; modelId?: string | null } }>(
    '/admin/ai-settings',
    {
      preHandler: requireRole('admin'),
      // canvas-80m: declarative validation (Fastify JSON Schema) instead of a hand-rolled `if`.
      schema: {
        tags: ['AI'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            chatEnabled: { type: 'boolean' },
            showUsageToUsers: { type: 'boolean' },
            modelId: { anyOf: [{ type: 'string', minLength: 1, maxLength: 200 }, { type: 'null' }] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { modelId } = request.body;
      if (typeof modelId === 'string') {
        // Only a model the provider actually offers (a typo would break every chat).
        let models;
        try {
          models = await listAiModels(process.env, fetchImpl);
        } catch (error) {
          if (error instanceof AiModelListError) return reply.code(502).send({ error: `${error.message} The model wasn't changed.` });
          throw error;
        }
        if (!models.some((m) => m.id === modelId)) return reply.code(400).send({ error: `The AI provider doesn't offer the model "${modelId}".` });
      }
      const before = modelId === undefined ? null : await getAiSettings();
      const settings = await setAiSettings(request.body);
      if (before && before.modelId !== settings.modelId) {
        await recordAudit({
          event: 'ai_model_set',
          actorUserId: request.session.user?.id,
          ip: clientIp(request),
          detail: { provider: settings.provider, from: before.effectiveModelId, to: settings.effectiveModelId, chosen: settings.modelId },
        });
      }
      return reply.send(settings);
    },
  );
}
