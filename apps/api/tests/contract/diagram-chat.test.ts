import type { FastifyInstance } from 'fastify';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getPool } from '../../src/db/pool.js';
import { closeTestDb, resetDatabase, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';
import { createDiagramTools } from '../../src/ai/diagram-tools.js';
import type { DiagramModel } from '@canvas/diagram-core';

/**
 * Feature 004, User Story 1: the 6 AI tool wrappers (direct unit-style tests, no LLM involved)
 * and the `/diagrams/:id/chat/messages` endpoint's HTTP-level contract (auth, persona lock-in,
 * the ai_settings gate) — using a minimal mock language model for the latter, since those tests
 * are about wiring/gating, not tool-selection behavior.
 */
function noToolCallResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
}

describe('diagram-tools (AI tool wrappers)', () => {
  let model: DiagramModel;
  const tools = createDiagramTools({
    getModel: () => model,
    setModel: (m) => {
      model = m;
    },
  });

  beforeEach(() => {
    model = {
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    };
  });

  it('addNode adds a node', async () => {
    const result = await tools.addNode.execute!({ shape: 'diamond', label: 'Decision' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.nodes.some((n) => n.label === 'Decision' && n.shape === 'diamond')).toBe(true);
  });

  it('addEdge adds an edge between two existing nodes', async () => {
    model.nodes.push({ id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } });
    const result = await tools.addEdge.execute!({ sourceId: 'a', targetId: 'b' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.edges.some((e) => e.sourceId === 'a' && e.targetId === 'b')).toBe(true);
  });

  it('addEdge reports not-found when a referenced node does not exist', async () => {
    const result = await tools.addEdge.execute!({ sourceId: 'a', targetId: 'does-not-exist' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model.edges).toHaveLength(0);
  });

  it('removeNode removes an existing node', async () => {
    const result = await tools.removeNode.execute!({ nodeId: 'a' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.nodes).toHaveLength(0);
  });

  it('removeNode reports not-found for a nonexistent id without changing the model', async () => {
    const before = model;
    const result = await tools.removeNode.execute!({ nodeId: 'does-not-exist' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });

  it('removeEdge reports not-found for a nonexistent id', async () => {
    const result = await tools.removeEdge.execute!({ edgeId: 'does-not-exist' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });

  it('updateNodeLabel renames an existing node', async () => {
    const result = await tools.updateNodeLabel.execute!({ nodeId: 'a', label: 'Renamed' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.nodes.find((n) => n.id === 'a')!.label).toBe('Renamed');
  });

  it('updateNodeLabel reports not-found for a nonexistent id', async () => {
    const result = await tools.updateNodeLabel.execute!({ nodeId: 'does-not-exist', label: 'X' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });

  it('updateEdgeLabel reports not-found for a nonexistent id', async () => {
    const result = await tools.updateEdgeLabel.execute!({ edgeId: 'does-not-exist', label: 'X' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });
});

describe('POST/GET /diagrams/:id/chat/messages', () => {
  let app: FastifyInstance;
  let architectCookie: string;
  let projectId: string;
  let diagramId: string;
  let personaId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({
      config,
      logger: false,
      languageModel: new MockLanguageModelV4({ doGenerate: noToolCallResult('Okay, done.') }),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    projectId = (await seedProject()).id;
    await seedUser({ email: 'architect@example.com', password: 'architect-pass' });

    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'])!.split(';')[0];

    const createDiagramResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: architectCookie },
      payload: { name: 'Chat Test Diagram', diagramTypeId: 'flowchart' },
    });
    diagramId = createDiagramResponse.json().diagram.id;

    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO ai_personas (name, category, system_prompt) VALUES ('Business Architect', 'Business', 'You are a business architect.') RETURNING id",
    );
    personaId = rows[0].id;

    await pool.query('UPDATE ai_settings SET chat_enabled = true');
  });

  it('returns 503 when AI chat is administratively disabled', async () => {
    const pool = getPool();
    await pool.query('UPDATE ai_settings SET chat_enabled = false');

    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'add a shape', currentDslContent: 'flowchart TD\n', personaId },
    });
    expect(response.statusCode).toBe(503);
  });

  it('creates a DiagramChat with the given personaId on the first message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'hello', currentDslContent: 'flowchart TD\n', personaId },
    });
    expect(response.statusCode).toBe(200);

    const pool = getPool();
    const { rows } = await pool.query('SELECT persona_id FROM diagram_chats WHERE diagram_id = $1', [diagramId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].persona_id).toBe(personaId);
  });

  it('ignores personaId on subsequent messages — the persona stays fixed', async () => {
    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'hello', currentDslContent: 'flowchart TD\n', personaId },
    });

    const pool = getPool();
    const { rows: otherPersona } = await pool.query<{ id: string }>(
      "INSERT INTO ai_personas (name, category, system_prompt) VALUES ('Other', 'Technical', 'x') RETURNING id",
    );

    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'again', currentDslContent: 'flowchart TD\n', personaId: otherPersona[0].id },
    });

    const { rows } = await pool.query('SELECT persona_id FROM diagram_chats WHERE diagram_id = $1', [diagramId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].persona_id).toBe(personaId);
  });

  it('requires edit-level diagram access', async () => {
    await seedUser({ email: 'other@example.com', password: 'other-pass' });
    const otherLogin = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'other@example.com', password: 'other-pass' } });
    const otherCookie = (Array.isArray(otherLogin.headers['set-cookie']) ? otherLogin.headers['set-cookie'][0] : otherLogin.headers['set-cookie'])!.split(';')[0];

    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: otherCookie },
      payload: { message: 'hello', currentDslContent: 'flowchart TD\n', personaId },
    });
    expect(response.statusCode).toBe(403);
  });

  it('GET returns the full message history in order', async () => {
    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'first', currentDslContent: 'flowchart TD\n', personaId },
    });
    await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'second', currentDslContent: 'flowchart TD\n' },
    });

    const response = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}/chat/messages`, headers: { cookie: architectCookie } });
    expect(response.statusCode).toBe(200);
    const messages = response.json().messages;
    expect(messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content)).toEqual(['first', 'second']);
  });

  it('GET returns an empty list for a diagram with no chat activity', async () => {
    const response = await app.inject({ method: 'GET', url: `/diagrams/${diagramId}/chat/messages`, headers: { cookie: architectCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toEqual([]);
  });
});
