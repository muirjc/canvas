import { getDb } from '../db/client.js';
import { currentTimestamp } from '../db/sql-helpers.js';

/**
 * canvas-zs0: per-model prices, per million tokens, for the estimated cost on Admin > AI usage.
 * Admin-entered: prices change and differ per provider, so none are built in.
 */
export interface ModelPrice {
  provider: string;
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  updatedAt?: string;
}

export async function listModelPrices(): Promise<ModelPrice[]> {
  const rows = await getDb().selectFrom('ai_model_prices').selectAll().orderBy('provider').orderBy('model_id').execute();
  return rows.map((r) => ({
    provider: r.provider,
    modelId: r.model_id,
    inputPerMillion: Number(r.input_per_million),
    outputPerMillion: Number(r.output_per_million),
    cacheReadPerMillion: Number(r.cache_read_per_million),
    cacheWritePerMillion: Number(r.cache_write_per_million),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function setModelPrice(price: ModelPrice): Promise<void> {
  const values = {
    input_per_million: price.inputPerMillion,
    output_per_million: price.outputPerMillion,
    cache_read_per_million: price.cacheReadPerMillion,
    cache_write_per_million: price.cacheWritePerMillion,
  };
  await getDb()
    .insertInto('ai_model_prices')
    .values({ provider: price.provider, model_id: price.modelId, ...values })
    .onConflict((oc) => oc.columns(['provider', 'model_id']).doUpdateSet({ ...values, updated_at: currentTimestamp() }))
    .execute();
}

/** Returns false when there was no such price. */
export async function deleteModelPrice(provider: string, modelId: string): Promise<boolean> {
  const result = await getDb()
    .deleteFrom('ai_model_prices')
    .where('provider', '=', provider)
    .where('model_id', '=', modelId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/** Models that have usage but no price -- the price editor offers them. */
export async function modelsWithoutPrice(): Promise<{ provider: string; modelId: string }[]> {
  const rows = await getDb()
    .selectFrom('ai_usage')
    .leftJoin('ai_model_prices', (join) =>
      join.onRef('ai_model_prices.provider', '=', 'ai_usage.provider').onRef('ai_model_prices.model_id', '=', 'ai_usage.model_id'),
    )
    .where('ai_model_prices.provider', 'is', null)
    .select(['ai_usage.provider as provider', 'ai_usage.model_id as modelId'])
    .distinct()
    .orderBy('ai_usage.provider')
    .orderBy('ai_usage.model_id')
    .execute();
  return rows;
}

export const priceKey = (provider: string, modelId: string) => `${provider}\u0000${modelId}`;

/**
 * Estimated cost in the price table's currency (USD). The provider's inputTokens includes the cached
 * tokens, which are priced at their own rates, so only the rest is charged at the input rate.
 */
export function estimateCost(
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  price: ModelPrice,
): number {
  const uncached = Math.max(0, tokens.inputTokens - tokens.cacheReadTokens - tokens.cacheWriteTokens);
  return (
    (uncached * price.inputPerMillion +
      tokens.cacheReadTokens * price.cacheReadPerMillion +
      tokens.cacheWriteTokens * price.cacheWritePerMillion +
      tokens.outputTokens * price.outputPerMillion) /
    1_000_000
  );
}
