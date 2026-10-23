import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '../db/client.js';
import { loadConfig } from '../config.js';
import { dbBoolean, toDate } from '../db/sql-helpers.js';
import { estimateCost, listModelPrices, priceKey, type ModelPrice } from './ai-prices.service.js';

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
  /** canvas-4k9: the assistant reply the turn produced (omitted for a failed turn). */
  chatMessageId?: string | null;
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
      chat_message_id: usage.chatMessageId ?? null,
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

/** canvas-zs0: admin-only figures -- cost from ai_model_prices; tokens of unpriced models apart. */
export interface CostFigures {
  /** Estimated cost (USD) of the priced models' tokens. */
  estimatedCost: number;
  /** Tokens from models with no price set (not included in estimatedCost). */
  unpricedTokens: number;
}

export interface UserUsageSummary extends UsageTotals, CostFigures {
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

const emptyTotals = (): UsageTotals & CostFigures => ({
  requests: 0,
  failedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  estimatedCost: 0,
  unpricedTokens: 0,
});

/** Adds one model's totals into `acc`, pricing them if that model has a price. */
function addModelTotals(acc: UsageTotals & CostFigures, t: UsageTotals, price: ModelPrice | undefined): void {
  acc.requests += t.requests;
  acc.failedRequests += t.failedRequests;
  acc.inputTokens += t.inputTokens;
  acc.outputTokens += t.outputTokens;
  acc.cacheReadTokens += t.cacheReadTokens;
  acc.cacheWriteTokens += t.cacheWriteTokens;
  acc.totalTokens += t.totalTokens;
  if (price) acc.estimatedCost += estimateCost(t, price);
  else acc.unpricedTokens += t.totalTokens;
}

async function priceLookup(): Promise<(provider: string, modelId: string) => ModelPrice | undefined> {
  const prices = new Map((await listModelPrices()).map((p) => [priceKey(p.provider, p.modelId), p]));
  return (provider, modelId) => prices.get(priceKey(provider, modelId));
}

/** Usage by user for [from, to), most tokens first, with the overall totals and estimated cost. */
export async function summarizeUsageByUser(
  from: Date,
  to: Date,
): Promise<{ users: UserUsageSummary[]; totals: UsageTotals & CostFigures }> {
  const priceOf = await priceLookup();
  const rows = await getDb()
    .selectFrom('ai_usage')
    .leftJoin('users', 'users.id', 'ai_usage.user_id')
    .where('ai_usage.occurred_at', '>=', from)
    .where('ai_usage.occurred_at', '<', to)
    .groupBy(['ai_usage.user_id', 'users.email', 'users.name', 'ai_usage.provider', 'ai_usage.model_id'])
    .select([
      'ai_usage.user_id as userId',
      'users.email as email',
      'users.name as name',
      'ai_usage.provider as provider',
      'ai_usage.model_id as modelId',
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
  const byUser = new Map<string, UserUsageSummary>();
  const totals = emptyTotals();
  for (const r of rows) {
    const key = r.userId ?? '';
    let user = byUser.get(key);
    const lastUsedAt = toDate(r.lastUsedAt).toISOString();
    if (!user) {
      user = { userId: r.userId, email: r.email, name: r.name, lastUsedAt, ...emptyTotals() };
      byUser.set(key, user);
    } else if (lastUsedAt > user.lastUsedAt) {
      user.lastUsedAt = lastUsedAt;
    }
    const t = totalsFrom(r);
    const price = priceOf(r.provider, r.modelId);
    addModelTotals(user, t, price);
    addModelTotals(totals, t, price);
  }
  return { users: [...byUser.values()].sort((a, b) => b.totalTokens - a.totalTokens), totals };
}

/** The UTC calendar day, on both engines (Postgres's to_char would use the session time zone). */
const utcDay = () =>
  loadConfig().dbClient === 'sqlite'
    ? sql<string>`strftime('%Y-%m-%d', ai_usage.occurred_at)`
    : sql<string>`to_char(ai_usage.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

/** One user's usage for [from, to): by day (UTC) and by model, with estimated cost. */
export async function userUsageDetail(
  userId: string,
  from: Date,
  to: Date,
): Promise<{
  byDay: (UsageTotals & CostFigures & { day: string })[];
  byModel: (UsageTotals & CostFigures & { provider: string; modelId: string; priced: boolean })[];
}> {
  const priceOf = await priceLookup();
  const day = utcDay();
  const rows = await getDb()
    .selectFrom('ai_usage')
    .where('ai_usage.user_id', '=', userId)
    .where('ai_usage.occurred_at', '>=', from)
    .where('ai_usage.occurred_at', '<', to)
    .select([
      day.as('day'),
      'ai_usage.provider as provider',
      'ai_usage.model_id as modelId',
      sums.requests.as('requests'),
      sums.failedRequests.as('failedRequests'),
      sums.inputTokens.as('inputTokens'),
      sums.outputTokens.as('outputTokens'),
      sums.cacheReadTokens.as('cacheReadTokens'),
      sums.cacheWriteTokens.as('cacheWriteTokens'),
    ])
    .groupBy([day, 'ai_usage.provider', 'ai_usage.model_id'])
    .execute();
  const byDay = new Map<string, UsageTotals & CostFigures & { day: string }>();
  const byModel = new Map<string, UsageTotals & CostFigures & { provider: string; modelId: string; priced: boolean }>();
  for (const r of rows) {
    const t = totalsFrom(r);
    const price = priceOf(r.provider, r.modelId);
    const d = byDay.get(r.day) ?? { day: r.day, ...emptyTotals() };
    addModelTotals(d, t, price);
    byDay.set(r.day, d);
    const key = priceKey(r.provider, r.modelId);
    const m = byModel.get(key) ?? { provider: r.provider, modelId: r.modelId, priced: Boolean(price), ...emptyTotals() };
    addModelTotals(m, t, price);
    byModel.set(key, m);
  }
  return {
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

// --- canvas-4k9: usage where people use AI (chat panel, own account) -- tokens only, never cost ---

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Token counts of the given assistant replies, by chat message id. */
export async function usageForMessages(messageIds: string[]): Promise<Map<string, TokenCounts>> {
  if (messageIds.length === 0) return new Map();
  const rows = await getDb()
    .selectFrom('ai_usage')
    .select(['chat_message_id', 'input_tokens', 'output_tokens'])
    .where('chat_message_id', 'in', messageIds)
    .execute();
  return new Map(
    rows.map((r) => [
      r.chat_message_id as string,
      { inputTokens: r.input_tokens, outputTokens: r.output_tokens, totalTokens: r.input_tokens + r.output_tokens },
    ]),
  );
}

/** Everything a diagram's conversation has used, failed turns included (by every collaborator). */
export async function diagramUsageTotal(diagramId: string): Promise<TokenCounts & { requests: number }> {
  const row = await getDb()
    .selectFrom('ai_usage')
    .where('diagram_id', '=', diagramId)
    .select([sums.requests.as('requests'), sums.inputTokens.as('inputTokens'), sums.outputTokens.as('outputTokens')])
    .executeTakeFirstOrThrow();
  const inputTokens = Number(row.inputTokens ?? 0);
  const outputTokens = Number(row.outputTokens ?? 0);
  return { requests: Number(row.requests ?? 0), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** One user's own totals for [from, to). */
export async function ownUsage(userId: string, from: Date, to: Date): Promise<TokenCounts & { requests: number }> {
  const row = await getDb()
    .selectFrom('ai_usage')
    .where('user_id', '=', userId)
    .where('occurred_at', '>=', from)
    .where('occurred_at', '<', to)
    .select([sums.requests.as('requests'), sums.inputTokens.as('inputTokens'), sums.outputTokens.as('outputTokens')])
    .executeTakeFirstOrThrow();
  const inputTokens = Number(row.inputTokens ?? 0);
  const outputTokens = Number(row.outputTokens ?? 0);
  return { requests: Number(row.requests ?? 0), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
