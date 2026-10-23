import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { dbBoolean } from '../../src/db/sql-helpers.js';
import { createMockLanguageModel } from '../../src/ai/mock-nlu.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/** canvas-9af: per-user AI token usage -- recording one row per chat turn, and the admin reports. */

type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
const usage = (u: Usage) => ({
  inputTokens: { total: u.input, noCache: u.input - (u.cacheRead ?? 0), cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 },
  outputTokens: { total: u.output, text: u.output, reasoning: 0 },
});
const textStep = (text: string, u: Usage) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: usage(u),
  warnings: [],
});
const toolStep = (u: Usage) => ({
  content: [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'addNode', input: JSON.stringify({ label: 'Start', shape: 'rectangle' }) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage: usage(u),
  warnings: [],
});

describe('AI usage (canvas-9af)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let architectId: string;
  let diagramId: string;
  let personaId: string;
  // The model's behaviour, swapped per test.
  let handler: (options: { prompt: { role: string }[] }) => Promise<unknown> = async () => textStep('ok', { input: 1, output: 1 });

  async function loginCookie(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const chat = (message = 'hello', extra: Record<string, unknown> = {}, cookie = architectCookie) =>
    app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie },
      payload: { message, currentDslContent: 'flowchart TD\n', personaId, ...extra },
    });
  const usageRows = () => getDb().selectFrom('ai_usage').selectAll().orderBy('occurred_at').execute();
  const iso = (d: string) => encodeURIComponent(new Date(d).toISOString());

  async function insertUsage(userId: string | null, at: string | Date, o: { input?: number; output?: number; ok?: boolean; provider?: string; model?: string; cacheRead?: number } = {}) {
    await getDb()
      .insertInto('ai_usage')
      .values({
        id: randomUUID(),
        occurred_at: new Date(at),
        user_id: userId,
        diagram_id: null,
        provider: o.provider ?? 'anthropic',
        model_id: o.model ?? 'claude-x',
        mode: 'build',
        steps: 1,
        input_tokens: o.input ?? 10,
        output_tokens: o.output ?? 5,
        cache_read_tokens: o.cacheRead ?? 0,
        cache_write_tokens: 0,
        succeeded: dbBoolean(o.ok ?? true),
      })
      .execute();
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({
      config,
      logger: false,
      languageModel: new MockLanguageModelV4({
        provider: 'test-provider',
        modelId: 'test-model',
        doGenerate: (async (options: { prompt: { role: string }[] }) => handler(options)) as never,
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    handler = async () => textStep('ok', { input: 1, output: 1 });
    await resetDatabase();
    await seedFlowchartDiagramType();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' }); // gitleaks:allow
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass' }); // gitleaks:allow
    architectId = architect.id;
    const projectId = (await seedProject('Usage Project', architectId)).id;
    adminCookie = await loginCookie('admin@example.com', 'admin-pass'); // gitleaks:allow
    architectCookie = await loginCookie('architect@example.com', 'architect-pass'); // gitleaks:allow
    diagramId = (
      await app.inject({ method: 'POST', url: `/projects/${projectId}/diagrams`, headers: { cookie: architectCookie }, payload: { name: 'D', diagramTypeId: 'flowchart' } })
    ).json().diagram.id;
    personaId = randomUUID();
    await getDb().insertInto('ai_personas').values({ id: personaId, name: 'P', category: 'Business', system_prompt: 'You help.' }).execute();
    await getDb().updateTable('ai_settings').set({ chat_enabled: dbBoolean(true) }).execute();
  });

  describe('recording a chat turn', () => {
    it('records one row for the signed-in user with the reported numbers', async () => {
      handler = async () => textStep('hi', { input: 120, output: 30 });
      expect((await chat()).statusCode).toBe(200);
      const rows = await usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: architectId,
        diagram_id: diagramId,
        provider: 'test-provider',
        model_id: 'test-model',
        mode: 'build',
        steps: 1,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      });
    });

    it('sums every step of a tool turn into one row', async () => {
      let calls = 0;
      handler = async () => (++calls === 1 ? toolStep({ input: 100, output: 20 }) : textStep('done', { input: 150, output: 10 }));
      expect((await chat('add a start node')).statusCode).toBe(200);
      expect(calls).toBe(2);
      const rows = await usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ steps: 2, input_tokens: 250, output_tokens: 30, succeeded: expect.anything() });
    });

    it('sums cache read and write tokens from the input token details', async () => {
      let calls = 0;
      handler = async () =>
        ++calls === 1
          ? toolStep({ input: 100, output: 20, cacheRead: 40, cacheWrite: 7 })
          : textStep('done', { input: 150, output: 10, cacheRead: 60, cacheWrite: 3 });
      await chat('add a start node');
      const [row] = await usageRows();
      expect(row).toMatchObject({ cache_read_tokens: 100, cache_write_tokens: 10, input_tokens: 250 });
    });

    it('a failure after the first step records the partial usage as failed, and the request still errors', async () => {
      let calls = 0;
      handler = async () => {
        if (++calls === 1) return toolStep({ input: 100, output: 20 });
        throw new Error('provider exploded');
      };
      const res = await chat('add a start node');
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      const rows = await usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ steps: 1, input_tokens: 100, output_tokens: 20, user_id: architectId });
      const summary = await app.inject({ method: 'GET', url: '/admin/ai-usage', headers: { cookie: adminCookie } });
      expect(summary.json().totals).toMatchObject({ requests: 1, failedRequests: 1 });
    });

    it('a failure on the first step records nothing', async () => {
      handler = async () => {
        throw new Error('provider down');
      };
      expect((await chat()).statusCode).toBeGreaterThanOrEqual(500);
      expect(await usageRows()).toHaveLength(0);
    });

    it('plan mode records mode = plan', async () => {
      handler = async () => textStep('a plan', { input: 5, output: 5 });
      expect((await chat('plan it', { mode: 'plan' })).statusCode).toBe(200);
      expect((await usageRows())[0].mode).toBe('plan');
    });

    it('a disabled chat (503) records nothing', async () => {
      await getDb().updateTable('ai_settings').set({ chat_enabled: dbBoolean(false) }).execute();
      expect((await chat()).statusCode).toBe(503);
      expect(await usageRows()).toHaveLength(0);
    });

    it('each turn is its own row', async () => {
      await chat('one');
      await chat('two');
      expect(await usageRows()).toHaveLength(2);
    });
  });

  describe('mock language model', () => {
    it('reports non-zero, deterministic usage', async () => {
      const call = async () => {
        const model = createMockLanguageModel();
        const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'add a node called Start' }] }];
        return model.doGenerate({ prompt } as never);
      };
      const a = await call();
      const b = await call();
      expect(a.usage.inputTokens.total).toBeGreaterThan(0);
      expect(a.usage.outputTokens.total).toBeGreaterThan(0);
      expect(b.usage).toEqual(a.usage);
    });
  });

  describe('GET /admin/ai-usage', () => {
    let bobId: string;
    beforeEach(async () => {
      bobId = (await seedUser({ email: 'bob@example.com', password: 'bob-pass', role: 'viewer' })).id; // gitleaks:allow
    });
    const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

    it('totals and per-user sums, sorted by total tokens, with lastUsedAt', async () => {
      await insertUsage(architectId, '2026-03-10T10:00:00Z', { input: 100, output: 50 });
      await insertUsage(architectId, '2026-03-12T10:00:00Z', { input: 200, output: 20, ok: false, cacheRead: 5 });
      await insertUsage(bobId, '2026-03-11T10:00:00Z', { input: 1000, output: 500 });
      const res = await get(`/admin/ai-usage?from=${iso('2026-03-01T00:00:00Z')}&to=${iso('2026-04-01T00:00:00Z')}`, adminCookie);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.users.map((u: { email: string }) => u.email)).toEqual(['bob@example.com', 'architect@example.com']);
      expect(body.users[0]).toMatchObject({ userId: bobId, requests: 1, failedRequests: 0, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
      expect(body.users[0].lastUsedAt).toBe('2026-03-11T10:00:00.000Z');
      expect(body.users[1]).toMatchObject({
        userId: architectId,
        requests: 2,
        failedRequests: 1,
        inputTokens: 300,
        outputTokens: 70,
        cacheReadTokens: 5,
        totalTokens: 370,
      });
      expect(body.users[1].lastUsedAt).toBe('2026-03-12T10:00:00.000Z');
      expect(body.totals).toMatchObject({ requests: 3, failedRequests: 1, inputTokens: 1300, outputTokens: 570, totalTokens: 1870 });
      expect(body.from).toBe('2026-03-01T00:00:00.000Z');
      expect(body.to).toBe('2026-04-01T00:00:00.000Z');
    });

    it('from is inclusive and to is exclusive', async () => {
      await insertUsage(architectId, '2026-03-01T00:00:00.000Z', { input: 1, output: 0 }); // exactly from
      await insertUsage(architectId, '2026-03-02T00:00:00.000Z', { input: 10, output: 0 }); // exactly to
      await insertUsage(architectId, '2026-02-28T23:59:59.999Z', { input: 100, output: 0 }); // just before
      const res = await get(`/admin/ai-usage?from=${iso('2026-03-01T00:00:00Z')}&to=${iso('2026-03-02T00:00:00Z')}`, adminCookie);
      expect(res.json().totals).toMatchObject({ requests: 1, inputTokens: 1 });
    });

    it('defaults to the last 30 days', async () => {
      const day = 24 * 60 * 60 * 1000;
      await insertUsage(architectId, new Date(Date.now() - 2 * day), { input: 7, output: 0 });
      await insertUsage(architectId, new Date(Date.now() - 40 * day), { input: 1000, output: 0 });
      const res = await get('/admin/ai-usage', adminCookie);
      expect(res.json().totals).toMatchObject({ requests: 1, inputTokens: 7 });
      const span = new Date(res.json().to).getTime() - new Date(res.json().from).getTime();
      expect(span).toBe(30 * day);
    });

    it('includes usage whose user is gone or unknown, without a name', async () => {
      await insertUsage(null, new Date(Date.now() - 1000), { input: 3, output: 0 });
      const res = await get('/admin/ai-usage', adminCookie);
      expect(res.json().users[0]).toMatchObject({ userId: null, email: null, inputTokens: 3 });
    });

    it('is empty with zero totals when nothing was used', async () => {
      const res = await get('/admin/ai-usage', adminCookie);
      expect(res.json()).toMatchObject({ users: [], totals: { requests: 0, totalTokens: 0 } });
    });

    it('400 when from is not before to', async () => {
      expect((await get(`/admin/ai-usage?from=${iso('2026-03-02T00:00:00Z')}&to=${iso('2026-03-01T00:00:00Z')}`, adminCookie)).statusCode).toBe(400);
      expect((await get(`/admin/ai-usage?from=${iso('2026-03-02T00:00:00Z')}&to=${iso('2026-03-02T00:00:00Z')}`, adminCookie)).statusCode).toBe(400);
      expect((await get('/admin/ai-usage?from=not-a-date', adminCookie)).statusCode).toBe(400);
    });

    it('403 for non-admins, 401 unauthenticated', async () => {
      expect((await get('/admin/ai-usage', architectCookie)).statusCode).toBe(403);
      expect((await get('/admin/ai-usage')).statusCode).toBe(401);
      expect((await get(`/admin/ai-usage/users/${architectId}`, architectCookie)).statusCode).toBe(403);
      expect((await get(`/admin/ai-usage/users/${architectId}`)).statusCode).toBe(401);
    });

    it('a real chat turn shows up in the report for that user', async () => {
      handler = async () => textStep('hi', { input: 120, output: 30 });
      await chat();
      const res = await get('/admin/ai-usage', adminCookie);
      expect(res.json().users[0]).toMatchObject({ userId: architectId, requests: 1, inputTokens: 120, outputTokens: 30 });
    });

    describe('user detail', () => {
      it('buckets by UTC day', async () => {
        // 23:30 and 00:30 UTC are one local day apart in the Americas and one UTC day apart here.
        await insertUsage(architectId, '2026-03-10T23:30:00Z', { input: 1, output: 0 });
        await insertUsage(architectId, '2026-03-11T00:30:00Z', { input: 10, output: 0 });
        await insertUsage(architectId, '2026-03-11T22:30:00Z', { input: 100, output: 0, ok: false });
        await insertUsage(bobId, '2026-03-11T01:00:00Z', { input: 9999, output: 0 });
        const res = await get(`/admin/ai-usage/users/${architectId}?from=${iso('2026-03-01T00:00:00Z')}&to=${iso('2026-04-01T00:00:00Z')}`, adminCookie);
        expect(res.statusCode).toBe(200);
        expect(res.json().byDay).toEqual([
          expect.objectContaining({ day: '2026-03-10', requests: 1, inputTokens: 1 }),
          expect.objectContaining({ day: '2026-03-11', requests: 2, failedRequests: 1, inputTokens: 110, totalTokens: 110 }),
        ]);
      });

      it('groups by provider and model, most tokens first, respecting the period', async () => {
        await insertUsage(architectId, '2026-03-10T10:00:00Z', { provider: 'anthropic', model: 'claude-a', input: 10, output: 0 });
        await insertUsage(architectId, '2026-03-10T11:00:00Z', { provider: 'anthropic', model: 'claude-a', input: 20, output: 0 });
        await insertUsage(architectId, '2026-03-10T12:00:00Z', { provider: 'openai', model: 'claude-a', input: 500, output: 0 });
        await insertUsage(architectId, '2026-03-10T13:00:00Z', { provider: 'anthropic', model: 'claude-b', input: 5, output: 0 });
        await insertUsage(architectId, '2026-05-10T13:00:00Z', { provider: 'anthropic', model: 'claude-b', input: 5000, output: 0 }); // outside
        const res = await get(`/admin/ai-usage/users/${architectId}?from=${iso('2026-03-01T00:00:00Z')}&to=${iso('2026-04-01T00:00:00Z')}`, adminCookie);
        expect(res.json().byModel).toEqual([
          expect.objectContaining({ provider: 'openai', modelId: 'claude-a', requests: 1, inputTokens: 500 }),
          expect.objectContaining({ provider: 'anthropic', modelId: 'claude-a', requests: 2, inputTokens: 30 }),
          expect.objectContaining({ provider: 'anthropic', modelId: 'claude-b', requests: 1, inputTokens: 5 }),
        ]);
      });

      it('is empty for a user with no usage, and 400 for a bad period', async () => {
        const res = await get(`/admin/ai-usage/users/${bobId}`, adminCookie);
        expect(res.json()).toMatchObject({ byDay: [], byModel: [] });
        const bad = await get(`/admin/ai-usage/users/${bobId}?from=${iso('2026-03-02T00:00:00Z')}&to=${iso('2026-03-01T00:00:00Z')}`, adminCookie);
        expect(bad.statusCode).toBe(400);
      });
    });
  });
});
