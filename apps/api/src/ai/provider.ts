import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export class UnconfiguredAiProviderError extends Error {}

const DEFAULT_MODEL_ID: Record<'anthropic' | 'openai', string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o',
};

/**
 * Resolves `AI_PROVIDER` (env-var configuration, mirroring this codebase's existing OIDC setup —
 * research.md §5) to a real language model instance. Test code does not call this: it passes a
 * hand-constructed `MockLanguageModelV4` (from `ai/test`) directly to the service functions that
 * would otherwise call this, via dependency injection (research.md §8).
 */
export function getLanguageModel(env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const providerName = env.AI_PROVIDER;
  const modelId = env.AI_MODEL;

  if (providerName === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new UnconfiguredAiProviderError('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set');
    }
    return createAnthropic({ apiKey })(modelId ?? DEFAULT_MODEL_ID.anthropic);
  }

  if (providerName === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new UnconfiguredAiProviderError('AI_PROVIDER=openai requires OPENAI_API_KEY to be set');
    }
    return createOpenAI({ apiKey })(modelId ?? DEFAULT_MODEL_ID.openai);
  }

  throw new UnconfiguredAiProviderError(
    `AI_PROVIDER must be set to "anthropic" or "openai" (got: ${providerName ?? 'unset'})`,
  );
}
