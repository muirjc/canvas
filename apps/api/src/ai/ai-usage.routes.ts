import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { clientIp, recordAudit } from '../audit/audit.service.js';
import { canSeeUsage } from './ai-settings.service.js';
import { ownUsage, summarizeUsageByUser, userUsageDetail } from './ai-usage.service.js';
import { deleteModelPrice, listModelPrices, modelsWithoutPrice, setModelPrice, type ModelPrice } from './ai-prices.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `from`/`to` as ISO date-times; `to` defaults to now, `from` to 30 days before `to`. The period
 *  is from <= t < to, so the default end is just after now: a turn recorded in this same
 *  millisecond still counts (a fast SQLite run sometimes left it out). */
function period(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date(Date.now() + 1);
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
  return { from, to };
}

const periodQuery = {
  type: 'object',
  properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } },
} as const;

/** canvas-9af: AI token usage for admins -- by user over a period, and one user's breakdown. */
export async function registerAiUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/admin/ai-usage',
    { preHandler: requireRole('admin'), schema: { tags: ['Admin'], security: [{ cookieAuth: [] }], querystring: periodQuery } },
    async (request, reply) => {
      const { from, to } = period(request.query);
      if (from >= to) return reply.code(400).send({ error: '`from` must be before `to`.' });
      return reply.send({ from: from.toISOString(), to: to.toISOString(), ...(await summarizeUsageByUser(from, to)) });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/admin/ai-usage/users/:id',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Admin'],
        security: [{ cookieAuth: [] }],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: periodQuery,
      },
    },
    async (request, reply) => {
      const { from, to } = period(request.query);
      if (from >= to) return reply.code(400).send({ error: '`from` must be before `to`.' });
      return reply.send({ from: from.toISOString(), to: to.toISOString(), ...(await userUsageDetail(request.params.id, from, to)) });
    },
  );

  // canvas-zs0: the price table behind the estimated cost (admin only, like the cost itself).
  app.get(
    '/admin/ai-prices',
    { preHandler: requireRole('admin'), schema: { tags: ['Admin'], security: [{ cookieAuth: [] }] } },
    async (_request, reply) => reply.send({ prices: await listModelPrices(), unpricedModels: await modelsWithoutPrice() }),
  );

  const price = { type: 'number', minimum: 0, maximum: 100000 } as const;
  app.put<{ Body: Omit<ModelPrice, 'updatedAt' | 'cacheReadPerMillion' | 'cacheWritePerMillion'> & Partial<Pick<ModelPrice, 'cacheReadPerMillion' | 'cacheWritePerMillion'>> }>(
    '/admin/ai-prices',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Admin'],
        security: [{ cookieAuth: [] }],
        body: {
          type: 'object',
          required: ['provider', 'modelId', 'inputPerMillion', 'outputPerMillion'],
          additionalProperties: false,
          properties: {
            provider: { type: 'string', minLength: 1, maxLength: 100 },
            modelId: { type: 'string', minLength: 1, maxLength: 200 },
            inputPerMillion: price,
            outputPerMillion: price,
            cacheReadPerMillion: price,
            cacheWritePerMillion: price,
          },
        },
      },
    },
    async (request, reply) => {
      const body: ModelPrice = { ...request.body, cacheReadPerMillion: request.body.cacheReadPerMillion ?? 0, cacheWritePerMillion: request.body.cacheWritePerMillion ?? 0 };
      await setModelPrice(body);
      await recordAudit({ event: 'ai_price_set', actorUserId: request.session.user?.id, ip: clientIp(request), detail: { ...body } });
      return reply.send({ prices: await listModelPrices() });
    },
  );

  app.delete<{ Querystring: { provider: string; modelId: string } }>(
    '/admin/ai-prices',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Admin'],
        security: [{ cookieAuth: [] }],
        querystring: {
          type: 'object',
          required: ['provider', 'modelId'],
          properties: { provider: { type: 'string' }, modelId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { provider, modelId } = request.query;
      if (!(await deleteModelPrice(provider, modelId))) return reply.code(404).send({ error: 'No price for that model.' });
      await recordAudit({ event: 'ai_price_removed', actorUserId: request.session.user?.id, ip: clientIp(request), detail: { provider, modelId } });
      return reply.send({ prices: await listModelPrices() });
    },
  );

  // canvas-4k9: your own tokens this calendar month (UTC) -- shown on the account screen. Tokens
  // only, never cost; hidden when an admin has turned usage display off for non-admins.
  app.get(
    '/me/ai-usage',
    { preHandler: requireAuth, schema: { tags: ['AI'], security: [{ cookieAuth: [] }] } },
    async (request, reply) => {
      const user = request.session.user!;
      if (!(await canSeeUsage(user.role))) return reply.send({ visible: false });
      const now = new Date();
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return reply.send({ visible: true, from: from.toISOString(), to: to.toISOString(), ...(await ownUsage(user.id, from, to)) });
    },
  );
}
