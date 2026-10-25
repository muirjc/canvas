import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { dbBoolean } from '../../src/db/sql-helpers.js';
import { clearAiModelCache } from '../../src/ai/ai-models.service.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/** canvas-tj1: the admin chooses the AI model from the provider's available models. */

const ENV_KEYS = ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_MODEL'] as const;
const KEY = 'sk-ant-SECRETKEY123456';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MODEL_LIST = {
  data: [
    { id: 'claude-a', display_name: 'Claude A', created_at: '2026-01-01T00:00:00Z' },
    { id: 'claude-b', display_name: 'Claude B', created_at: '2025-01-01T00:00:00Z' },
  ],
  has_more: false,
};

describe('AI model choice (canvas-tj1)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let saved: Record<string, string | undefined>;
  let aiFetch: ReturnType<typeof vi.fn>;

  async function loginCookie(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'PATCH', url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
  const patch = (payload: unknown) => call('PATCH', '/admin/ai-settings', adminCookie, payload);
  // `detail` is JSON: an object on Postgres, text on SQLite.
  const audits = async () =>
    (await getDb().selectFrom('audit_events').select(['event', 'actor_user_id', 'detail']).where('event', '=', 'ai_model_set').execute()).map((r) => ({
      ...r,
      detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
    }));
  const storedModel = async () => (await getDb().selectFrom('ai_settings').select('model_id').executeTakeFirstOrThrow()).model_id;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    aiFetch = vi.fn();
    app = await buildApp({ config, logger: false, aiFetch: ((...args: unknown[]) => aiFetch(...args)) as never });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = KEY;
    delete process.env.AI_MODEL;
    clearAiModelCache();
    aiFetch.mockReset();
    aiFetch.mockImplementation(async () => json(MODEL_LIST));
    await resetDatabase();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' }); // gitleaks:allow
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' }); // gitleaks:allow
    adminCookie = await loginCookie('admin@example.com', 'admin-pass'); // gitleaks:allow
    architectCookie = await loginCookie('architect@example.com', 'architect-pass'); // gitleaks:allow
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearAiModelCache();
  });

  describe('GET /admin/ai-models', () => {
    it('is admin-only', async () => {
      expect((await call('GET', '/admin/ai-models')).statusCode).toBe(401);
      expect((await call('GET', '/admin/ai-models', architectCookie)).statusCode).toBe(403);
    });

    it('lists the provider models with the current and default choice', async () => {
      const res = await call('GET', '/admin/ai-models', adminCookie);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.provider).toBe('anthropic');
      expect(body.models.map((m: { id: string }) => m.id)).toEqual(['claude-a', 'claude-b']);
      expect(body.modelId).toBeNull();
      expect(body.defaultModelId).toBe('claude-sonnet-5');
      expect(body.error).toBeUndefined();
    });

    it('answers 200 with an error and no models when listing fails', async () => {
      aiFetch.mockImplementation(async () => json({}, 500));
      const res = await call('GET', '/admin/ai-models', adminCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json().models).toEqual([]);
      expect(res.json().error).toEqual(expect.any(String));
      expect(res.body).not.toContain('SECRETKEY');
    });

    it('answers 200 with an error when the provider is unreachable', async () => {
      aiFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await call('GET', '/admin/ai-models', adminCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ models: [], error: expect.any(String) });
    });

    it('answers 200 with an error when no provider is configured', async () => {
      delete process.env.AI_PROVIDER;
      const res = await call('GET', '/admin/ai-models', adminCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ provider: 'unconfigured', models: [], error: expect.any(String) });
    });
  });

  describe('PATCH /admin/ai-settings modelId', () => {
    it('saves an offered model, visible in both settings endpoints', async () => {
      const res = await patch({ modelId: 'claude-b' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ modelId: 'claude-b', effectiveModelId: 'claude-b', defaultModelId: 'claude-sonnet-5' });
      expect(await storedModel()).toBe('claude-b');
      for (const [url, cookie] of [['/admin/ai-settings', adminCookie], ['/ai-settings', architectCookie]] as const) {
        expect((await call('GET', url, cookie)).json()).toMatchObject({ modelId: 'claude-b', effectiveModelId: 'claude-b' });
      }
    });

    it('works with only modelId (no other field, no empty SET)', async () => {
      await patch({ chatEnabled: true });
      const res = await patch({ modelId: 'claude-a' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ chatEnabled: true, modelId: 'claude-a' });
    });

    it('leaves the stored model alone when only chatEnabled is patched', async () => {
      await patch({ modelId: 'claude-a' });
      const res = await patch({ chatEnabled: true });
      expect(res.json()).toMatchObject({ chatEnabled: true, modelId: 'claude-a' });
      expect(await storedModel()).toBe('claude-a');
    });

    it('rejects a model the provider does not offer with 400 and changes nothing', async () => {
      await patch({ modelId: 'claude-a' });
      const res = await patch({ modelId: 'claude-typo' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('claude-typo');
      expect(await storedModel()).toBe('claude-a');
      expect(await audits()).toHaveLength(1);
    });

    it('answers 502 and changes nothing when the model list cannot be fetched', async () => {
      await patch({ modelId: 'claude-a' });
      clearAiModelCache();
      aiFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await patch({ modelId: 'claude-b' });
      expect(res.statusCode).toBe(502);
      expect(await storedModel()).toBe('claude-a');
      expect(await audits()).toHaveLength(1);
    });

    it('null returns to the default, without consulting the provider', async () => {
      await patch({ modelId: 'claude-a' });
      aiFetch.mockReset();
      aiFetch.mockRejectedValue(new Error('down'));
      const res = await patch({ modelId: null });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ modelId: null, effectiveModelId: 'claude-sonnet-5' });
      expect(await storedModel()).toBeNull();
    });

    it.each([[123], [''], ['x'.repeat(201)], [true]])('rejects an invalid modelId %#', async (modelId) => {
      const res = await patch({ modelId });
      expect(res.statusCode).toBe(400);
      expect(await storedModel()).toBeNull();
    });

    it('rejects an empty body', async () => {
      expect((await patch({})).statusCode).toBe(400);
    });

    it('is admin-only', async () => {
      const res = await call('PATCH', '/admin/ai-settings', architectCookie, { modelId: 'claude-a' });
      expect(res.statusCode).toBe(403);
      expect(await storedModel()).toBeNull();
    });

    it('uses AI_MODEL as the default when set', async () => {
      process.env.AI_MODEL = 'claude-b';
      expect((await call('GET', '/admin/ai-settings', adminCookie)).json()).toMatchObject({ modelId: null, defaultModelId: 'claude-b', effectiveModelId: 'claude-b' });
    });
  });

  describe('audit ai_model_set', () => {
    it('is recorded once with from/to/chosen and the actor when the choice changes', async () => {
      await patch({ modelId: 'claude-b' });
      const rows = await audits();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toEqual(expect.any(String));
      expect(rows[0].detail).toMatchObject({ provider: 'anthropic', from: 'claude-sonnet-5', to: 'claude-b', chosen: 'claude-b' });
    });

    it('records the move back to the default', async () => {
      await patch({ modelId: 'claude-b' });
      await patch({ modelId: null });
      const rows = await audits();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.detail)).toContainEqual(expect.objectContaining({ from: 'claude-b', to: 'claude-sonnet-5', chosen: null }));
    });

    it('is not recorded when the choice is unchanged', async () => {
      await patch({ modelId: 'claude-b' });
      await patch({ modelId: 'claude-b' });
      await patch({ modelId: null });
      await patch({ modelId: null });
      expect(await audits()).toHaveLength(2);
    });

    it('is not recorded when only chatEnabled changes', async () => {
      await patch({ chatEnabled: true });
      await patch({ showUsageToUsers: false });
      expect(await audits()).toHaveLength(0);
    });
  });

  describe('mock provider', () => {
    it('ignores a stored model and offers just the mock', async () => {
      await patch({ modelId: 'claude-a' });
      process.env.AI_PROVIDER = 'mock';
      const settings = (await call('GET', '/admin/ai-settings', adminCookie)).json();
      expect(settings).toMatchObject({ provider: 'mock', modelId: null, defaultModelId: 'mock', effectiveModelId: 'mock' });
      const models = (await call('GET', '/admin/ai-models', adminCookie)).json();
      expect(models.models.map((m: { id: string }) => m.id)).toEqual(['mock']);
    });

    it('accepts only the mock model', async () => {
      process.env.AI_PROVIDER = 'mock';
      expect((await patch({ modelId: 'claude-a' })).statusCode).toBe(400);
    });
  });
});

/**
 * With no injected model, chat builds its model from the admin's choice. The Anthropic endpoint is
 * stubbed at the global fetch boundary; nothing leaves the process.
 */
describe('chat uses the chosen model (canvas-tj1)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let diagramId: string;
  let personaId: string;
  let saved: Record<string, string | undefined>;
  const requestedModels: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({ config, logger: false });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = KEY;
    delete process.env.AI_MODEL;
    requestedModels.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { body?: unknown }) => {
        if (!String(url).startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call to ${String(url)}`);
        requestedModels.push(JSON.parse(String(init?.body)).model);
        return json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: requestedModels.at(-1),
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    await resetDatabase();
    await seedFlowchartDiagramType();
    const user = await seedUser({ email: 'architect@example.com', password: 'architect-pass' }); // gitleaks:allow
    const projectId = (await seedProject('P', user.id)).id;
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } }); // gitleaks:allow
    cookie = String(login.headers['set-cookie']).split(';')[0];
    diagramId = (await app.inject({ method: 'POST', url: `/projects/${projectId}/diagrams`, headers: { cookie }, payload: { name: 'D', diagramTypeId: 'flowchart' } })).json().diagram.id;
    personaId = randomUUID();
    await getDb().insertInto('ai_personas').values({ id: personaId, name: 'P', category: 'Business', system_prompt: 'You help.' }).execute();
    await getDb().updateTable('ai_settings').set({ chat_enabled: dbBoolean(true) }).execute();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const chat = () =>
    app.inject({ method: 'POST', url: `/diagrams/${diagramId}/chat/messages`, headers: { cookie }, payload: { message: 'hello', currentDslContent: 'flowchart TD\n', personaId } });

  it('sends the chosen model id to the provider and records it as usage', async () => {
    await getDb().updateTable('ai_settings').set({ model_id: 'claude-chosen' }).execute();
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(requestedModels).toEqual(['claude-chosen']);
    const rows = await getDb().selectFrom('ai_usage').select('model_id').execute();
    expect(rows.map((r) => r.model_id)).toEqual(['claude-chosen']);
  });

  it('falls back to the default model when none is chosen', async () => {
    expect((await chat()).statusCode).toBe(200);
    expect(requestedModels).toEqual(['claude-sonnet-5']);
  });
});
