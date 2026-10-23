import { describe, expect, it } from 'vitest';
import { estimateCost, type ModelPrice } from '../../src/ai/ai-prices.service.js';

const price: ModelPrice = { provider: 'p', modelId: 'm', inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 };

describe('estimateCost', () => {
  it('prices plain input and output per million tokens', () => {
    expect(estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, price)).toBeCloseTo(18, 10);
    expect(estimateCost({ inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, price)).toBeCloseTo((500 * 3 + 200 * 15) / 1e6, 12);
  });

  it('charges cached tokens at their own rates and only the rest at the input rate', () => {
    // 1M input of which 200k read from cache and 100k written to it: 700k at 3, 200k at 0.3, 100k at 3.75.
    const cost = estimateCost({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 200_000, cacheWriteTokens: 100_000 }, price);
    expect(cost).toBeCloseTo(2.1 + 0.06 + 0.375 + 1.5, 10);
  });

  it('never charges negative uncached input when cache tokens exceed the input total', () => {
    const cost = estimateCost({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 80, cacheWriteTokens: 50 }, price);
    expect(cost).toBeCloseTo((80 * 0.3 + 50 * 3.75) / 1e6, 12);
    expect(cost).toBeGreaterThan(0);
  });

  it('is zero for zero tokens and for a free model', () => {
    expect(estimateCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, price)).toBe(0);
    const free = { ...price, inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
    expect(estimateCost({ inputTokens: 9, outputTokens: 9, cacheReadTokens: 1, cacheWriteTokens: 1 }, free)).toBe(0);
  });
});
