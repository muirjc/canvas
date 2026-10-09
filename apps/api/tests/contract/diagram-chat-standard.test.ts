import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDb } from '../../src/db/client.js';
import { dbBoolean } from '../../src/db/sql-helpers.js';
import { createMockLanguageModel } from '../../src/ai/mock-nlu.js';
import { sendChatMessage } from '../../src/ai/diagram-chat.service.js';
import { createDraftStandard, publishStandard } from '../../src/standards/standard.service.js';
import { VALUE_CHAIN_STANDARD } from '../../src/seed/reference-standards.seed.js';
import { closeTestDb, resetDatabase, seedDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * canvas-tfr: the chat channel under a published Standards v2 standard -- the standard section
 * reaches the system prompt only when a diagramTypeId is supplied, and the mock NLU's
 * "add a <kind id> called X" drives addElement end to end through sendChatMessage.
 */
describe('sendChatMessage with a published standard', () => {
  let app: FastifyInstance;
  let cookie: string;
  let diagramId: string;
  const TYPE_ID = 'value-chain-chat-test';

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
    await seedDiagramType(TYPE_ID, 'flowchart', 'Value Chain Test');
    const user = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    const projectId = (await seedProject('Standard Chat Project', user.id)).id;
    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'])!.split(';')[0];
    await getDb().updateTable('ai_settings').set({ chat_enabled: dbBoolean(true) }).execute();

    const draft = await createDraftStandard({ diagramTypeId: TYPE_ID, rules: VALUE_CHAIN_STANDARD, name: 'VC' });
    await publishStandard(draft.id);

    const created = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie },
      payload: { name: 'VC Diagram', diagramTypeId: TYPE_ID },
    });
    diagramId = created.json().diagram.id;
  });

  const INTROSPECT = 'what do you know about this diagram?';

  it('includes the standard section in the system prompt when diagramTypeId is given', async () => {
    const result = await sendChatMessage({
      diagramId,
      message: INTROSPECT,
      currentDslContent: 'flowchart TD\n',
      dslFamily: 'flowchart',
      diagramTypeId: TYPE_ID,
      model: createMockLanguageModel(),
    });
    expect(result.assistantMessage).toContain('Standard for this diagram');
    expect(result.assistantMessage).toContain('primary_activity');
    expect(result.assistantMessage).toContain('#dbeafe');
  });

  it('has no standard section without diagramTypeId', async () => {
    const result = await sendChatMessage({
      diagramId,
      message: INTROSPECT,
      currentDslContent: 'flowchart TD\n',
      dslFamily: 'flowchart',
      model: createMockLanguageModel(),
    });
    expect(result.assistantMessage).not.toContain('Standard for this diagram');
  });

  it('places the standard after the family primer and shows kind and violations in the model summary', async () => {
    const dsl = await sendChatMessage({
      diagramId,
      message: 'add a primary_activity called Operations',
      currentDslContent: 'flowchart TD\n',
      dslFamily: 'flowchart',
      diagramTypeId: TYPE_ID,
      model: createMockLanguageModel(),
    });
    const result = await sendChatMessage({
      diagramId,
      message: INTROSPECT,
      currentDslContent: dsl.updatedDslContent,
      dslFamily: 'flowchart',
      diagramTypeId: TYPE_ID,
      model: createMockLanguageModel(),
    });
    const system = result.assistantMessage;
    expect(system.indexOf('Standard for this diagram')).toBeGreaterThan(-1);
    expect(system).toContain('kind: primary_activity');
    expect(system).toContain('Current standard violations');
  });

  it('"add a primary_activity called Operations" yields a :::primary_activity node via addElement', async () => {
    const result = await sendChatMessage({
      diagramId,
      message: 'add a primary_activity called Operations',
      currentDslContent: 'flowchart TD\n',
      dslFamily: 'flowchart',
      diagramTypeId: TYPE_ID,
      model: createMockLanguageModel(),
    });
    expect(result.toolCalls).toEqual([{ tool: 'addElement', applied: true }]);
    expect(result.updatedDslContent).toContain(':::primary_activity');
    expect(result.updatedDslContent).toContain('Operations');
  });

  it('the chat route passes the diagram type through (standard-driven addElement over HTTP)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie },
      payload: { message: 'add a primary_activity called Operations', currentDslContent: 'flowchart TD\n' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().updatedDslContent).toContain(':::primary_activity');
  });
});
