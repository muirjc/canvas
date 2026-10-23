import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { dbBoolean } from '../../src/db/sql-helpers.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/** canvas-zs0 (estimated cost, admin only) and canvas-4k9 (token counts in chat and on the account). */

type Usage = { input: number; output: number };
const usage = (u: Usage) => ({
  inputTokens: { total: u.input, noCache: u.input, cacheRead: 0, cacheWrite: 0 },
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

describe('AI cost and chat usage (canvas-zs0, canvas-4k9)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let architectId: string;
  let otherId: string;
  let diagramId: string;
  let handler: (options: unknown) => Promise<unknown> = async () => textStep('ok', { input: 1, output: 1 });

  async function loginCookie(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as object });
  const chat = (cookie = architectCookie, message = 'hello') =>
    call('POST', `/diagrams/${diagramId}/chat/messages`, cookie, { message, currentDslContent: 'flowchart TD\n' });
  const iso = (d: string | Date) => encodeURIComponent(new Date(d).toISOString());
  const setShow = (show: boolean) => call('PATCH', '/admin/ai-settings', adminCookie, { showUsageToUsers: show });

  async function insertUsage(userId: string | null, at: string | Date, o: { input?: number; output?: number; model?: string; provider?: string; cacheRead?: number; cacheWrite?: number } = {}) {
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
        cache_write_tokens: o.cacheWrite ?? 0,
        succeeded: dbBoolean(true),
      })
      .execute();
  }
  const putPrice = (body: Record<string, unknown>, cookie = adminCookie) => call('PUT', '/admin/ai-prices', cookie, body);
  const PRICE = { provider: 'anthropic', modelId: 'claude-x', inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({
      config,
      logger: false,
      languageModel: new MockLanguageModelV4({ provider: 'test-provider', modelId: 'test-model', doGenerate: ((o: unknown) => handler(o)) as never }),
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
    architectId = (await seedUser({ email: 'architect@example.com', password: 'architect-pass' })).id; // gitleaks:allow
    otherId = (await seedUser({ email: 'other@example.com', password: 'other-pass' })).id; // gitleaks:allow
    const projectId = (await seedProject('Cost Project', architectId)).id;
    adminCookie = await loginCookie('admin@example.com', 'admin-pass'); // gitleaks:allow
    architectCookie = await loginCookie('architect@example.com', 'architect-pass'); // gitleaks:allow
    diagramId = (await call('POST', `/projects/${projectId}/diagrams`, architectCookie, { name: 'D', diagramTypeId: 'flowchart' })).json().diagram.id;
    await getDb().updateTable('ai_settings').set({ chat_enabled: dbBoolean(true) }).execute();
  });

  describe('prices', () => {
    it('upserts, lists, and defaults the cache prices to 0', async () => {
      const created = await putPrice({ provider: 'p', modelId: 'm', inputPerMillion: 1, outputPerMillion: 2 });
      expect(created.statusCode).toBe(200);
      expect(created.json().prices).toEqual([expect.objectContaining({ provider: 'p', modelId: 'm', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0, cacheWritePerMillion: 0 })]);

      const updated = await putPrice({ provider: 'p', modelId: 'm', inputPerMillion: 5, outputPerMillion: 6, cacheReadPerMillion: 0.5 });
      expect(updated.json().prices).toHaveLength(1);
      expect(updated.json().prices[0]).toMatchObject({ inputPerMillion: 5, outputPerMillion: 6, cacheReadPerMillion: 0.5 });
      expect((await call('GET', '/admin/ai-prices', adminCookie)).json().prices).toHaveLength(1);
    });

    it('validates: negative, missing and mistyped fields are 400; unknown properties are stripped, not stored', async () => {
      expect((await putPrice({ ...PRICE, inputPerMillion: -1 })).statusCode).toBe(400);
      expect((await putPrice({ provider: 'p', modelId: 'm', inputPerMillion: 1 })).statusCode).toBe(400);
      expect((await putPrice({ ...PRICE, provider: '' })).statusCode).toBe(400);
      expect((await putPrice({ ...PRICE, inputPerMillion: '3' })).statusCode).toBe(400);
      expect((await call('GET', '/admin/ai-prices', adminCookie)).json().prices).toHaveLength(0);
      // Fastify's AJV removes properties the schema doesn't list (removeAdditional) instead of rejecting.
      const extra = await putPrice({ ...PRICE, currency: 'EUR' });
      expect(extra.statusCode).toBe(200);
      expect(extra.json().prices[0]).not.toHaveProperty('currency');
    });

    it('delete removes a price, and 404s when there is none', async () => {
      await putPrice(PRICE);
      const q = '?provider=anthropic&modelId=claude-x';
      const removed = await call('DELETE', `/admin/ai-prices${q}`, adminCookie);
      expect(removed.statusCode).toBe(200);
      expect(removed.json().prices).toEqual([]);
      expect((await call('DELETE', `/admin/ai-prices${q}`, adminCookie)).statusCode).toBe(404);
    });

    it('is admin only: 403 for non-admins, 401 unauthenticated', async () => {
      expect((await call('GET', '/admin/ai-prices', architectCookie)).statusCode).toBe(403);
      expect((await putPrice(PRICE, architectCookie)).statusCode).toBe(403);
      expect((await call('DELETE', '/admin/ai-prices?provider=a&modelId=b', architectCookie)).statusCode).toBe(403);
      expect((await call('GET', '/admin/ai-prices')).statusCode).toBe(401);
    });

    it('unpricedModels lists models with usage but no price, and drops one once priced', async () => {
      await insertUsage(architectId, new Date(), { provider: 'anthropic', model: 'claude-x' });
      await insertUsage(architectId, new Date(), { provider: 'openai', model: 'gpt-y' });
      const before = (await call('GET', '/admin/ai-prices', adminCookie)).json().unpricedModels;
      expect(before).toEqual([
        { provider: 'anthropic', modelId: 'claude-x' },
        { provider: 'openai', modelId: 'gpt-y' },
      ]);
      await putPrice(PRICE);
      expect((await call('GET', '/admin/ai-prices', adminCookie)).json().unpricedModels).toEqual([{ provider: 'openai', modelId: 'gpt-y' }]);
    });

    it('records audit rows for set and removed', async () => {
      await putPrice(PRICE);
      await call('DELETE', '/admin/ai-prices?provider=anthropic&modelId=claude-x', adminCookie);
      const events = (await call('GET', '/admin/audit?limit=50', adminCookie)).json().events as { event: string; actorEmail: string; detail: Record<string, unknown> }[];
      expect(events.find((e) => e.event === 'ai_price_set')).toMatchObject({ actorEmail: 'admin@example.com', detail: { provider: 'anthropic', modelId: 'claude-x', inputPerMillion: 3 } });
      expect(events.find((e) => e.event === 'ai_price_removed')).toMatchObject({ actorEmail: 'admin@example.com', detail: { provider: 'anthropic', modelId: 'claude-x' } });
    });
  });

  describe('estimated cost in the reports', () => {
    const FROM = '2026-03-01T00:00:00Z';
    const TO = '2026-04-01T00:00:00Z';
    beforeEach(async () => {
      await putPrice(PRICE);
      // Priced model: 1M input (200k cache read, 100k cache write), 100k output = $4.035.
      await insertUsage(architectId, '2026-03-10T10:00:00Z', { input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheWrite: 100_000 });
      // Unpriced model on the same user and day.
      await insertUsage(architectId, '2026-03-10T11:00:00Z', { model: 'mystery', input: 500, output: 500 });
      // A second user with only the priced model: 1M input, no output = $3.
      await insertUsage(otherId, '2026-03-11T10:00:00Z', { input: 1_000_000, output: 0 });
    });

    it('per user and total cost count only priced models; the rest is unpricedTokens', async () => {
      const body = (await call('GET', `/admin/ai-usage?from=${iso(FROM)}&to=${iso(TO)}`, adminCookie)).json();
      const arch = body.users.find((u: { userId: string }) => u.userId === architectId);
      const other = body.users.find((u: { userId: string }) => u.userId === otherId);
      expect(arch.estimatedCost).toBeCloseTo(4.035, 6);
      expect(arch.unpricedTokens).toBe(1000);
      expect(arch.requests).toBe(2);
      expect(arch.totalTokens).toBe(1_100_000 + 1000);
      expect(other.estimatedCost).toBeCloseTo(3, 6);
      expect(other.unpricedTokens).toBe(0);
      expect(body.totals.estimatedCost).toBeCloseTo(7.035, 6);
      expect(body.totals.unpricedTokens).toBe(1000);
      expect(body.totals.requests).toBe(3);
    });

    it('with no prices at all the cost is 0 and every token is unpriced', async () => {
      await call('DELETE', '/admin/ai-prices?provider=anthropic&modelId=claude-x', adminCookie);
      const body = (await call('GET', `/admin/ai-usage?from=${iso(FROM)}&to=${iso(TO)}`, adminCookie)).json();
      expect(body.totals.estimatedCost).toBe(0);
      expect(body.totals.unpricedTokens).toBe(body.totals.totalTokens);
    });

    it('user detail has cost by day and by model, with a priced flag', async () => {
      const body = (await call('GET', `/admin/ai-usage/users/${architectId}?from=${iso(FROM)}&to=${iso(TO)}`, adminCookie)).json();
      expect(body.byDay).toHaveLength(1);
      expect(body.byDay[0]).toMatchObject({ day: '2026-03-10', unpricedTokens: 1000, requests: 2 });
      expect(body.byDay[0].estimatedCost).toBeCloseTo(4.035, 6);
      const priced = body.byModel.find((m: { modelId: string }) => m.modelId === 'claude-x');
      const unpriced = body.byModel.find((m: { modelId: string }) => m.modelId === 'mystery');
      expect(priced).toMatchObject({ priced: true, unpricedTokens: 0 });
      expect(priced.estimatedCost).toBeCloseTo(4.035, 6);
      expect(unpriced).toMatchObject({ priced: false, estimatedCost: 0, unpricedTokens: 1000 });
    });

    it('changing a price reprices history', async () => {
      await putPrice({ ...PRICE, inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 });
      const body = (await call('GET', `/admin/ai-usage?from=${iso(FROM)}&to=${iso(TO)}`, adminCookie)).json();
      expect(body.totals.estimatedCost).toBe(0);
      expect(body.totals.unpricedTokens).toBe(1000);
    });
  });

  describe('usage in the chat panel', () => {
    it('POST returns the turn usage and the assistant message id; GET has per-reply usage and a total', async () => {
      handler = async () => textStep('hi', { input: 120, output: 30 });
      const res = await chat();
      expect(res.statusCode).toBe(200);
      expect(res.json().usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
      const assistantId = res.json().assistantMessageId as string;
      expect(assistantId).toBeTruthy();

      const messages = (await call('GET', `/diagrams/${diagramId}/chat/messages`, architectCookie)).json();
      const reply = messages.messages.find((m: { id: string }) => m.id === assistantId);
      expect(reply).toMatchObject({ role: 'assistant', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } });
      expect(messages.messages.find((m: { role: string }) => m.role === 'user').usage).toBeUndefined();
      expect(messages.usageTotal).toEqual({ requests: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    });

    it('the usage row links to the stored assistant message', async () => {
      const res = await chat();
      const stored = await getDb().selectFrom('chat_messages').select('id').where('role', '=', 'assistant').executeTakeFirstOrThrow();
      const row = await getDb().selectFrom('ai_usage').selectAll().executeTakeFirstOrThrow();
      expect(res.json().assistantMessageId).toBe(stored.id);
      expect(row.chat_message_id).toBe(stored.id);
    });

    it('usageTotal sums the diagram\'s turns including a failed turn\'s partial usage, which has no message link', async () => {
      handler = async () => textStep('a', { input: 120, output: 30 });
      await chat();
      let calls = 0;
      handler = async () => {
        if (++calls === 1) return toolStep({ input: 100, output: 20 });
        throw new Error('boom');
      };
      expect((await chat(architectCookie, 'add a node')).statusCode).toBeGreaterThanOrEqual(500);

      const rows = await getDb().selectFrom('ai_usage').selectAll().orderBy('occurred_at').execute();
      expect(rows).toHaveLength(2);
      expect(rows[0].chat_message_id).not.toBeNull();
      expect(rows[1].chat_message_id).toBeNull();
      const messages = (await call('GET', `/diagrams/${diagramId}/chat/messages`, architectCookie)).json();
      expect(messages.usageTotal).toEqual({ requests: 2, inputTokens: 220, outputTokens: 50, totalTokens: 270 });
    });

    it('when an admin turns display off, non-admins get no usage at all, admins still do', async () => {
      handler = async () => textStep('hi', { input: 120, output: 30 });
      expect((await setShow(false)).statusCode).toBe(200);

      const post = await chat();
      expect(post.statusCode).toBe(200);
      expect(post.json().usage).toBeUndefined();
      const get = (await call('GET', `/diagrams/${diagramId}/chat/messages`, architectCookie)).json();
      expect(get.usageTotal).toBeUndefined();
      expect(get.messages.every((m: { usage?: unknown }) => m.usage === undefined)).toBe(true);
      expect(JSON.stringify(get)).not.toContain('120');

      const adminGet = (await call('GET', `/diagrams/${diagramId}/chat/messages`, adminCookie)).json();
      expect(adminGet.usageTotal).toMatchObject({ requests: 1, totalTokens: 150 });
      expect(adminGet.messages.find((m: { role: string }) => m.role === 'assistant').usage).toMatchObject({ totalTokens: 150 });

      // Recording is unaffected by the display setting.
      expect(await getDb().selectFrom('ai_usage').selectAll().execute()).toHaveLength(1);
      // An admin sending a message still gets usage back.
      expect((await chat(adminCookie)).json().usage).toBeTruthy();
    });

    it('turning display back on restores it', async () => {
      await setShow(false);
      await setShow(true);
      expect((await chat()).json().usage).toBeTruthy();
    });

    it('chat responses never include a cost', async () => {
      await putPrice({ ...PRICE, provider: 'test-provider', modelId: 'test-model' });
      await chat();
      const body = JSON.stringify((await call('GET', `/diagrams/${diagramId}/chat/messages`, adminCookie)).json());
      expect(body.toLowerCase()).not.toContain('cost');
    });
  });

  describe('GET /me/ai-usage', () => {
    it('counts only this month\'s own rows', async () => {
      const now = new Date();
      await insertUsage(architectId, now, { input: 100, output: 20 });
      await insertUsage(architectId, now, { input: 1, output: 1 });
      await insertUsage(architectId, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15)), { input: 5000, output: 5000 });
      await insertUsage(otherId, now, { input: 9000, output: 9000 });
      const res = await call('GET', '/me/ai-usage', architectCookie);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ visible: true, requests: 2, inputTokens: 101, outputTokens: 21, totalTokens: 122 });
      expect(body.from).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());
      expect(body.to).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());
      expect(JSON.stringify(body).toLowerCase()).not.toContain('cost');
    });

    it('is zero for a user with no usage', async () => {
      expect((await call('GET', '/me/ai-usage', architectCookie)).json()).toMatchObject({ visible: true, requests: 0, totalTokens: 0 });
    });

    it('is {visible:false} for non-admins when off, but admins still see totals', async () => {
      await insertUsage(architectId, new Date(), { input: 10, output: 5 });
      await insertUsage((await getDb().selectFrom('users').select('id').where('email', '=', 'admin@example.com').executeTakeFirstOrThrow()).id, new Date(), { input: 7, output: 3 });
      await setShow(false);
      expect((await call('GET', '/me/ai-usage', architectCookie)).json()).toEqual({ visible: false });
      expect((await call('GET', '/me/ai-usage', adminCookie)).json()).toMatchObject({ visible: true, totalTokens: 10 });
    });

    it('requires authentication', async () => {
      expect((await call('GET', '/me/ai-usage')).statusCode).toBe(401);
    });
  });

  describe('PATCH /admin/ai-settings', () => {
    it('rejects an empty body and wrongly typed values', async () => {
      expect((await call('PATCH', '/admin/ai-settings', adminCookie, {})).statusCode).toBe(400);
      expect((await call('PATCH', '/admin/ai-settings', adminCookie, { showUsageToUsers: 'no' })).statusCode).toBe(400);
      expect((await call('PATCH', '/admin/ai-settings', adminCookie, { chatEnabled: 1 })).statusCode).toBe(400);
    });

    it('an unknown property is ignored, never applied (AJV strips it)', async () => {
      const before = (await call('PATCH', '/admin/ai-settings', adminCookie, { chatEnabled: true })).json();
      const res = await call('PATCH', '/admin/ai-settings', adminCookie, { chatEnabled: false, nope: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ chatEnabled: false, showUsageToUsers: before.showUsageToUsers });
      expect(res.json()).not.toHaveProperty('nope');
    });

    it('chatEnabled-only still works and leaves showUsageToUsers alone, and vice versa', async () => {
      const a = await call('PATCH', '/admin/ai-settings', adminCookie, { chatEnabled: false });
      expect(a.statusCode).toBe(200);
      expect(a.json()).toMatchObject({ chatEnabled: false, showUsageToUsers: true });
      const b = await call('PATCH', '/admin/ai-settings', adminCookie, { showUsageToUsers: false });
      expect(b.json()).toMatchObject({ chatEnabled: false, showUsageToUsers: false });
      const c = await call('PATCH', '/admin/ai-settings', adminCookie, { chatEnabled: true, showUsageToUsers: true });
      expect(c.json()).toMatchObject({ chatEnabled: true, showUsageToUsers: true });
    });

    it('is admin only', async () => {
      expect((await call('PATCH', '/admin/ai-settings', architectCookie, { showUsageToUsers: false })).statusCode).toBe(403);
    });
  });
});
