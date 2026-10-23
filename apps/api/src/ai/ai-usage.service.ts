import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '../db/client.js';
import { loadConfig } from '../config.js';
import { dbBoolean, toDate } from '../db/sql-helpers.js';

/**
 * canvas-9af: AI token usage per user -- AI chat costs money per token and nothing recorded how
 * much each person used. One row per chat turn; a turn is several model calls when the model uses
 * tools, so its tokens are summed across the steps (including a turn that failed partway).
 */

export interface TurnUsage {
  userId: string | null;
  diagramId: string | null;
  provider: string;
  modelId: string;
  mode: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  succeeded: boolean;
}

export async function recordAiUsage(usage: TurnUsage): Promise<void> {
  await getDb()
    .insertInto('ai_usage')
    .values({
      id: randomUUID(),
      // Set here (not the column default) for millisecond precision on SQLite too.
      occurred_at: new Date(),
      user_id: usage.userId,
      diagram_id: usage.diagramId,
      provider: usage.provider,
      model_id: usage.modelId,
      mode: usage.mode,
      steps: usage.steps,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
      succeeded: dbBoolean(usage.succeeded),
    })
    .execute();
}

export interface UsageTotals {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface UserUsageSummary extends UsageTotals {
  userId: string | null;
  email: string | null;
  name: string | null;
  lastUsedAt: string;
}

const sums = {
  requests: sql<string>`COUNT(*)`,
  failedRequests: sql<string>`SUM(CASE WHEN ai_usage.succeeded THEN 0 ELSE 1 END)`,
  inputTokens: sql<string>`SUM(ai_usage.input_tokens)`,
  outputTokens: sql<string>`SUM(ai_usage.output_tokens)`,
  cacheReadTokens: sql<string>`SUM(ai_usage.cache_read_tokens)`,
  cacheWriteTokens: sql<string>`SUM(ai_usage.cache_write_tokens)`,
};

function totalsFrom(row: Record<keyof typeof sums, string | number | null>): UsageTotals {
  const n = (v: string | number | null) => Number(v ?? 0);
  const inputTokens = n(row.inputTokens);
  const outputTokens = n(row.outputTokens);
  return {
    requests: n(row.requests),
    failedRequests: n(row.failedRequests),
    inputTokens,
    outputTokens,
    cacheReadTokens: n(row.cacheReadTokens),
    cacheWriteTokens: n(row.cacheWriteTokens),
    totalTokens: inputTokens + outputTokens,
  };
}

/** Usage by user for [from, to), most tokens first, with the overall totals. */
export async function summarizeUsageByUser(from: Date, to: Date): Promise<{ users: UserUsageSummary[]; totals: UsageTotals }> {
  const db = getDb();
  const rows = await db
    .selectFrom('ai_usage')
    .leftJoin('users', 'users.id', 'ai_usage.user_id')
    .where('ai_usage.occurred_at', '>=', from)
    .where('ai_usage.occurred_at', '<', to)
    .groupBy(['ai_usage.user_id', 'users.email', 'users.name'])
    .select([
      'ai_usage.user_id as userId',
      'users.email as email',
      'users.name as name',
      sums.requests.as('requests'),
      sums.failedRequests.as('failedRequests'),
      sums.inputTokens.as('inputTokens'),
      sums.outputTokens.as('outputTokens'),
      sums.cacheReadTokens.as('cacheReadTokens'),
      sums.cacheWriteTokens.as('cacheWriteTokens'),
      // A Date from Postgres, ISO text from SQLite (this app writes occurred_at itself).
      sql<Date | string>`MAX(ai_usage.occurred_at)`.as('lastUsedAt'),
    ])
    .execute();
  const users = rows
    .map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      lastUsedAt: toDate(r.lastUsedAt).toISOString(),
      ...totalsFrom(r),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const totals = users.reduce<UsageTotals>(
    (acc, u) => ({
      requests: acc.requests + u.requests,
      failedRequests: acc.failedRequests + u.failedRequests,
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + u.cacheWriteTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }),
    { requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  );
  return { users, totals };
}

/** One user's usage for [from, to): by day (UTC) and by model. */
export async function userUsageDetail(
  userId: string,
  from: Date,
  to: Date,
): Promise<{ byDay: (UsageTotals & { day: string })[]; byModel: (UsageTotals & { provider: string; modelId: string })[] }> {
  const db = getDb();
  const base = db
    .selectFrom('ai_usage')
    .where('ai_usage.user_id', '=', userId)
    .where('ai_usage.occurred_at', '>=', from)
    .where('ai_usage.occurred_at', '<', to);
  // UTC day on both engines. (Not the shared dateToYMD: on Postgres its to_char() formats in the
  // session's time zone, which put a late-evening request on the wrong day.)
  const day =
    loadConfig().dbClient === 'sqlite'
      ? sql<string>`strftime('%Y-%m-%d', ai_usage.occurred_at)`
      : sql<string>`to_char(ai_usage.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const byDay = await base
    .select([
      day.as('day'),
      sums.requests.as('requests'),
      sums.failedRequests.as('failedRequests'),
      sums.inputTokens.as('inputTokens'),
      sums.outputTokens.as('outputTokens'),
      sums.cacheReadTokens.as('cacheReadTokens'),
      sums.cacheWriteTokens.as('cacheWriteTokens'),
    ])
    .groupBy(day)
    .orderBy(day)
    .execute();
  const byModel = await base
    .select([
      'ai_usage.provider as provider',
      'ai_usage.model_id as modelId',
      sums.requests.as('requests'),
      sums.failedRequests.as('failedRequests'),
      sums.inputTokens.as('inputTokens'),
      sums.outputTokens.as('outputTokens'),
      sums.cacheReadTokens.as('cacheReadTokens'),
      sums.cacheWriteTokens.as('cacheWriteTokens'),
    ])
    .groupBy(['ai_usage.provider', 'ai_usage.model_id'])
    .execute();
  return {
    byDay: byDay.map((r) => ({ day: r.day, ...totalsFrom(r) })),
    byModel: byModel.map((r) => ({ provider: r.provider, modelId: r.modelId, ...totalsFrom(r) })).sort((a, b) => b.totalTokens - a.totalTokens),
  };
}
