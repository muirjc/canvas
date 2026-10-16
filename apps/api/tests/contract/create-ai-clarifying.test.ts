import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { dbBoolean } from '../../src/db/sql-helpers.js';
import { createMockLanguageModel } from '../../src/ai/mock-nlu.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-ltm: "Create with AI" follow-up questions. A vague request gets a text-only question
 * (no tool calls, DSL untouched); the answer and the "Create diagram" message are then handled by
 * concrete mock-NLU rules, and the whole exchange is persisted in order.
 */
describe('Create with AI: clarifying-question chat flow', () => {
  let app: FastifyInstance;
  let cookie: string;
  let diagramId: string;
  let personaId: string;
  const EMPTY_DSL = 'flowchart TD\n';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({ config, logger: false, languageModel: createMockLanguageModel() });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const user = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    const projectId = (await seedProject('Clarify Project', user.id)).id;
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'])!.split(';')[0];
    const created = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie },
      payload: { name: 'Clarify Diagram', diagramTypeId: 'flowchart' },
    });
    diagramId = created.json().diagram.id;

    const db = getDb();
    personaId = randomUUID();
    await db.insertInto('ai_personas').values({ id: personaId, name: 'Business Architect', category: 'Business', system_prompt: 'You are a business architect.' }).execute();
    await db.updateTable('ai_settings').set({ chat_enabled: dbBoolean(true) }).execute();
  });

  async function send(message: string, currentDslContent: string, withPersona = false, mode?: 'plan' | 'build') {
    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie },
      payload: { message, currentDslContent, ...(withPersona ? { personaId } : {}), ...(mode ? { mode } : {}) },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { assistantMessage: string; toolCalls: { name?: string; toolName?: string }[]; updatedDslContent: string };
  }

  it('asks a question for a vague request, then draws once answered, and persists the exchange in order', async () => {
    const first = await send('Create a diagram of our order process', EMPTY_DSL, true);
    expect(first.toolCalls).toEqual([]);
    expect(first.assistantMessage).toBe('Before I draw this, what are the main steps or elements you want included?');
    expect(first.updatedDslContent).toBe(EMPTY_DSL);

    const second = await send('Add a shape called Order Received', first.updatedDslContent);
    expect(second.toolCalls).toHaveLength(1);
    expect(second.updatedDslContent).toContain('Order Received');

    const history = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}/chat/messages`, headers: { cookie } });
    const messages = history.json().messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[0].content).toBe('Create a diagram of our order process');
    expect(messages[2].content).toBe('Add a shape called Order Received');
  });

  it('draws a placeholder step when told to go ahead and draw', async () => {
    const first = await send('Create a diagram of our order process', EMPTY_DSL, true);
    const draw = await send('Please go ahead and draw the diagram now with sensible defaults.', first.updatedDslContent);
    expect(draw.toolCalls).toHaveLength(1);
    expect(draw.updatedDslContent).toContain('Draft step');
  });

  describe('canvas-s3o: plan vs build mode', () => {
    it('plan mode never draws: a concrete request is played back, DSL untouched', async () => {
      const plan = await send('Add a shape called Order Received', EMPTY_DSL, true, 'plan');
      expect(plan.toolCalls).toEqual([]);
      expect(plan.updatedDslContent).toBe(EMPTY_DSL);
      expect(plan.assistantMessage).toBe(
        'Here\'s what I\'ll build: "Add a shape called Order Received". Click Create diagram when you\'re ready.',
      );
    });

    it('plan mode answers a vague request with the clarifying question', async () => {
      const plan = await send('Create a diagram of our order process', EMPTY_DSL, true, 'plan');
      expect(plan.toolCalls).toEqual([]);
      expect(plan.assistantMessage).toBe('Before I draw this, what are the main steps or elements you want included?');
      expect(plan.updatedDslContent).toBe(EMPTY_DSL);
    });

    it('plan mode adds the planning section to the system prompt; build mode does not', async () => {
      const plan = await send('what do you know about this diagram?', EMPTY_DSL, true, 'plan');
      expect(plan.assistantMessage).toContain('## Create with AI — planning');
      const build = await send('what do you know about this diagram?', EMPTY_DSL, false, 'build');
      expect(build.assistantMessage).not.toContain('## Create with AI — planning');
      const dflt = await send('what do you know about this diagram?', EMPTY_DSL);
      expect(dflt.assistantMessage).not.toContain('## Create with AI — planning');
    });

    it('a build turn after a plan turn draws what was planned, and history keeps all four messages in order', async () => {
      const plan = await send('Add a shape called Order Received', EMPTY_DSL, true, 'plan');
      expect(plan.updatedDslContent).toBe(EMPTY_DSL);
      const buildMessage = 'Please create the diagram now, as discussed.';
      const build = await send(buildMessage, plan.updatedDslContent, false, 'build');
      expect(build.toolCalls).toHaveLength(1);
      expect(build.updatedDslContent).toContain('Order Received');

      const history = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}/chat/messages`, headers: { cookie } });
      const messages = history.json().messages as { role: string; content: string }[];
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(messages[0].content).toBe('Add a shape called Order Received');
      expect(messages[2].content).toBe(buildMessage);
    });

    it('rejects an invalid mode with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/chat/messages`,
        headers: { cookie },
        payload: { message: 'Add a shape called X', currentDslContent: EMPTY_DSL, mode: 'draw' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('defaults to build: a concrete request without a mode draws immediately', async () => {
      const result = await send('Add a shape called Order Received', EMPTY_DSL);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.updatedDslContent).toContain('Order Received');
    });
  });
});
