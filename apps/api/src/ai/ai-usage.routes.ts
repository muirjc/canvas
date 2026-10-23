import type { FastifyInstance } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { summarizeUsageByUser, userUsageDetail } from './ai-usage.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `from`/`to` as ISO date-times; `to` defaults to now, `from` to 30 days before `to`. */
function period(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date();
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
}
