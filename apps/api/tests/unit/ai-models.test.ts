import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiModelListError, clearAiModelCache, listAiModels } from '../../src/ai/ai-models.service.js';
import { defaultModelId, getLanguageModel } from '../../src/ai/provider.js';

/** canvas-tj1: listing the provider's models, and resolving which one a chat uses. */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const KEY = 'sk-test-SECRETKEY123456'; // gitleaks:allow (made up)

describe('listAiModels()', () => {
  beforeEach(() => clearAiModelCache());
  afterEach(() => clearAiModelCache());

  it('returns the single mock model without fetching', async () => {
    const fetchImpl = vi.fn();
    const models = await listAiModels({ AI_PROVIDER: 'mock' }, fetchImpl as never);
    expect(models.map((m) => m.id)).toEqual(['mock']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('anthropic', () => {
    const env = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY };

    it('pages via has_more/last_id, sends the auth headers, falls back to id for the name, sorts newest first', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          json({
            data: [
              { id: 'old', display_name: 'Old One', created_at: '2024-01-01T00:00:00Z' },
              { id: 'no-name', created_at: '2025-01-01T00:00:00Z' },
            ],
            has_more: true,
            last_id: 'no-name',
          }),
        )
        .mockResolvedValueOnce(json({ data: [{ id: 'newest', display_name: 'Newest', created_at: '2026-01-01T00:00:00Z' }], has_more: false, last_id: 'newest' }));
      const models = await listAiModels(env, fetchImpl as never);
      expect(models.map((m) => m.id)).toEqual(['newest', 'no-name', 'old']);
      expect(models.find((m) => m.id === 'no-name')!.name).toBe('no-name');
      expect(models.find((m) => m.id === 'old')!.name).toBe('Old One');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [url1, init1] = fetchImpl.mock.calls[0];
      expect(url1).toBe('https://api.anthropic.com/v1/models?limit=1000');
      expect(init1.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': expect.any(String) });
      expect(fetchImpl.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=no-name');
    });
  });

  describe('openai', () => {
    const env = { AI_PROVIDER: 'openai', OPENAI_API_KEY: KEY };
    const included = ['gpt-4o', 'gpt-5', 'o3', 'chatgpt-4o-latest'];
    const excluded = [
      'text-embedding-3-small',
      'whisper-1',
      'dall-e-3',
      'gpt-4o-audio-preview',
      'gpt-4o-realtime-preview',
      'gpt-4o-mini-tts',
      'omni-moderation-latest',
      'gpt-4o-search-preview',
    ];

    it('keeps chat models only, with a bearer token, newest first', async () => {
      const data = [...included, ...excluded].map((id, i) => ({ id, created: 1_700_000_000 + i * 1000 }));
      const fetchImpl = vi.fn().mockResolvedValue(json({ data }));
      const models = await listAiModels(env, fetchImpl as never);
      expect(models.map((m) => m.id).sort()).toEqual([...included].sort());
      // 'chatgpt-4o-latest' has the largest created among the included.
      expect(models[0].id).toBe('chatgpt-4o-latest');
      expect(fetchImpl.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
      expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    });
  });

  describe('errors', () => {
    const anthropic = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY };

    it.each([
      ['no key', { AI_PROVIDER: 'anthropic' }],
      ['key "unset"', { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'unset' }],
      ['no provider', {}],
    ])('throws AiModelListError with %s, without fetching', async (_n, env) => {
      const fetchImpl = vi.fn();
      await expect(listAiModels(env, fetchImpl as never)).rejects.toBeInstanceOf(AiModelListError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([401, 403, 500])('throws AiModelListError on HTTP %i without leaking the key', async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(json({ error: `bad key ${KEY}` }, status));
      const error = await listAiModels(anthropic, fetchImpl as never).catch((e) => e);
      expect(error).toBeInstanceOf(AiModelListError);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain('SECRETKEY');
    });

    it('distinguishes a rejected key from another status', async () => {
      const rejected = await listAiModels(anthropic, vi.fn().mockResolvedValue(json({}, 401)) as never).catch((e) => e);
      const server = await listAiModels(anthropic, vi.fn().mockResolvedValue(json({}, 500)) as never).catch((e) => e);
      expect(rejected.message).toMatch(/rejected/);
      expect(server.message).toMatch(/500/);
    });

    it('throws AiModelListError on a network error without leaking the key', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect ECONNREFUSED using ${KEY}`));
      const error = await listAiModels(anthropic, fetchImpl as never).catch((e) => e);
      expect(error).toBeInstanceOf(AiModelListError);
      expect(error.message).not.toContain('SECRETKEY');
    });

    it('does not cache a failure', async () => {
      await listAiModels(anthropic, vi.fn().mockResolvedValue(json({}, 500)) as never).catch(() => undefined);
      const ok = vi.fn().mockResolvedValue(json({ data: [{ id: 'm' }] }));
      expect((await listAiModels(anthropic, ok as never)).map((m) => m.id)).toEqual(['m']);
    });
  });

  describe('caching', () => {
    it('serves a second call within 10 minutes from cache, refetches after, and refetches for a different key', async () => {
      vi.useFakeTimers();
      try {
        const env = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'key-aaaaaa111111' };
        const fetchImpl = vi.fn().mockImplementation(async () => json({ data: [{ id: 'm' }] }));
        await listAiModels(env, fetchImpl as never);
        await listAiModels(env, fetchImpl as never);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await listAiModels({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'key-bbbbbb222222' }, fetchImpl as never);
        expect(fetchImpl).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(10 * 60_000 + 1);
        await listAiModels({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'key-bbbbbb222222' }, fetchImpl as never);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not share a cache between providers', async () => {
      const fetchImpl = vi.fn().mockImplementation(async () => json({ data: [{ id: 'gpt-4o' }] }));
      await listAiModels({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY }, fetchImpl as never);
      await listAiModels({ AI_PROVIDER: 'openai', OPENAI_API_KEY: KEY }, fetchImpl as never);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});

describe('getLanguageModel() model choice', () => {
  const anthropic = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY };
  const modelIdOf = (m: unknown) => (m as { modelId: string }).modelId;

  it('chosen wins over AI_MODEL, which wins over the default', () => {
    expect(modelIdOf(getLanguageModel({ ...anthropic, AI_MODEL: 'env-model' }, 'chosen-model'))).toBe('chosen-model');
    expect(modelIdOf(getLanguageModel({ ...anthropic, AI_MODEL: 'env-model' }, null))).toBe('env-model');
    expect(modelIdOf(getLanguageModel({ ...anthropic, AI_MODEL: 'env-model' }))).toBe('env-model');
    expect(modelIdOf(getLanguageModel(anthropic, null))).toBe('claude-sonnet-5');
  });

  it('applies to openai too', () => {
    const openai = { AI_PROVIDER: 'openai', OPENAI_API_KEY: KEY };
    expect(modelIdOf(getLanguageModel(openai, 'gpt-5'))).toBe('gpt-5');
    expect(modelIdOf(getLanguageModel(openai))).toBe('gpt-4o');
  });
});

describe('defaultModelId()', () => {
  it('is AI_MODEL else the provider default; mock for mock; null when unconfigured', () => {
    expect(defaultModelId({ AI_PROVIDER: 'anthropic' })).toBe('claude-sonnet-5');
    expect(defaultModelId({ AI_PROVIDER: 'anthropic', AI_MODEL: 'x' })).toBe('x');
    expect(defaultModelId({ AI_PROVIDER: 'openai' })).toBe('gpt-4o');
    expect(defaultModelId({ AI_PROVIDER: 'openai', AI_MODEL: 'y' })).toBe('y');
    expect(defaultModelId({ AI_PROVIDER: 'mock' })).toBe('mock');
    expect(defaultModelId({})).toBeNull();
  });
});
