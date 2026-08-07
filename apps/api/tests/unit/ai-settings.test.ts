import { describe, expect, it } from 'vitest';
import { resolveAiProviderKind } from '../../src/ai/ai-settings.service.js';

/**
 * canvas-wuc: `resolveAiProviderKind()` is the pure, display-only mapping from `AI_PROVIDER` to
 * the client-facing `AiProviderKind`. Mirrors `config.test.ts`'s style of passing an explicit
 * `env` object rather than mutating real `process.env`.
 */
describe('resolveAiProviderKind()', () => {
  it('resolves AI_PROVIDER=mock to "mock"', () => {
    expect(resolveAiProviderKind({ AI_PROVIDER: 'mock' })).toBe('mock');
  });

  it('resolves AI_PROVIDER=anthropic to "anthropic"', () => {
    expect(resolveAiProviderKind({ AI_PROVIDER: 'anthropic' })).toBe('anthropic');
  });

  it('resolves AI_PROVIDER=openai to "openai"', () => {
    expect(resolveAiProviderKind({ AI_PROVIDER: 'openai' })).toBe('openai');
  });

  it('resolves an unset AI_PROVIDER to "unconfigured"', () => {
    expect(resolveAiProviderKind({})).toBe('unconfigured');
  });

  it('resolves an unrecognized AI_PROVIDER value to "unconfigured"', () => {
    expect(resolveAiProviderKind({ AI_PROVIDER: 'not-a-real-provider' })).toBe('unconfigured');
  });
});
