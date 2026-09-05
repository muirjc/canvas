import type { FastifyInstance } from 'fastify';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getPool } from '../../src/db/pool.js';
import { getDiagramTypePrimer } from '../../src/ai/diagram-type-primers.js';
import { closeTestDb, resetDatabase, seedDiagramType, seedFlowchartDiagramType, seedProject, seedUser } from '../helpers/setup.js';

/**
 * Feature 004 User Story 1 + 010-ai-diagram-knowledge: the `/diagrams/:id/chat/messages`
 * endpoint's HTTP-level contract (auth, persona lock-in, the ai_settings gate, and — as of
 * 010-ai-diagram-knowledge — dslFamily resolution, cross-family access-control parity, and
 * standards-validation parity for AI-tool-driven edits), using a minimal mock language model,
 * since these tests are about wiring/gating, not tool-selection behavior. The AI tool wrappers
 * themselves (direct unit-style tests, no LLM involved) live in diagram-tools.test.ts.
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
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    // Owned by the acting user: projects became access-controlled in feature 007, so a
    // fixture project must name who works in it.
    projectId = (await seedProject('Test Project', architect.id)).id;

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

/**
 * 010-ai-diagram-knowledge, T002/T009: `sendChatMessage` used to hardcode `getDslFamily('flowchart')`
 * regardless of the diagram's real type — confirmed live, not hypothetical (research.md §1) — so a
 * chat request against any non-flowchart diagram threw a 422 DslParseError. These tests exercise
 * every one of the 6 registered families through the real HTTP endpoint, with a no-tool-call mock
 * response (matching this file's own established wiring-test convention) so a 200 + a stable
 * parse→serialize round-trip proves the CORRECT family's parser/serializer was used, not flowchart's.
 */
describe('POST /diagrams/:id/chat/messages — every diagram family (010-ai-diagram-knowledge)', () => {
  let app: FastifyInstance;
  let architectCookie: string;
  let projectId: string;
  let personaId: string;

  const FAMILY_FIXTURES: { diagramTypeId: string; dslFamily: string; dslContent: string; needle: string }[] = [
    { diagramTypeId: 'c4-test', dslFamily: 'c4', dslContent: 'C4Context\nPerson(user, "User")\n', needle: 'Person(user' },
    { diagramTypeId: 'sequence-test', dslFamily: 'sequence', dslContent: 'sequenceDiagram\nAlice->>Bob: Hello\n', needle: 'Alice' },
    { diagramTypeId: 'erd-test', dslFamily: 'erd', dslContent: 'erDiagram\nCUSTOMER {\n  string name\n}\n', needle: 'CUSTOMER' },
    { diagramTypeId: 'uml-test', dslFamily: 'uml', dslContent: 'classDiagram\nclass Foo\n', needle: 'Foo' },
    { diagramTypeId: 'architecture-test', dslFamily: 'architecture', dslContent: 'architecture-beta\nservice api(cloud)[API]\n', needle: 'api(cloud)' },
  ];

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
    for (const fixture of FAMILY_FIXTURES) {
      await seedDiagramType(fixture.diagramTypeId, fixture.dslFamily);
    }
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    projectId = (await seedProject('Test Project', architect.id)).id;

    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'])!.split(';')[0];

    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO ai_personas (name, category, system_prompt) VALUES ('Business Architect', 'Business', 'You are a business architect.') RETURNING id",
    );
    personaId = rows[0].id;
    await pool.query('UPDATE ai_settings SET chat_enabled = true');
  });

  it.each(FAMILY_FIXTURES)(
    'succeeds for $dslFamily and round-trips the diagram content through the correct family, not flowchart',
    async ({ diagramTypeId, dslContent, needle }) => {
      const createDiagramResponse = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/diagrams`,
        headers: { cookie: architectCookie },
        payload: { name: `${diagramTypeId} diagram`, diagramTypeId },
      });
      expect(createDiagramResponse.statusCode).toBe(201);
      const diagramId = createDiagramResponse.json().diagram.id;

      const response = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/chat/messages`,
        headers: { cookie: architectCookie },
        payload: { message: 'hello', currentDslContent: dslContent, personaId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().updatedDslContent).toContain(needle);
    },
  );

  it.each(FAMILY_FIXTURES)(
    'denies a view-only user identically (403) on $dslFamily as it already does on flowchart (FR-011)',
    async ({ diagramTypeId, dslContent }) => {
      const createDiagramResponse = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/diagrams`,
        headers: { cookie: architectCookie },
        payload: { name: `${diagramTypeId} diagram`, diagramTypeId },
      });
      const diagramId = createDiagramResponse.json().diagram.id;

      const viewer = await seedUser({ email: `viewer-${diagramTypeId}@example.com`, password: 'viewer-pass' });
      await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/shares`,
        headers: { cookie: architectCookie },
        payload: { granteeUserId: viewer.id, accessLevel: 'view' },
      });
      const viewerLogin = await app.inject({
        method: 'POST',
        url: '/auth/local/login',
        payload: { email: `viewer-${diagramTypeId}@example.com`, password: 'viewer-pass' },
      });
      const viewerCookie = (Array.isArray(viewerLogin.headers['set-cookie']) ? viewerLogin.headers['set-cookie'][0] : viewerLogin.headers['set-cookie'])!.split(';')[0];

      const response = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/chat/messages`,
        headers: { cookie: viewerCookie },
        payload: { message: 'hello', currentDslContent: dslContent, personaId },
      });
      expect(response.statusCode).toBe(403);
    },
  );
});

/**
 * 010-ai-diagram-knowledge, T020: Constitution Principle II ("no bypass for AI-tool-driven
 * mutations") — an AI-tool-driven edit that produces a value violating the diagram's active
 * Standard must be flagged by the same computeValidation path a manual edit already goes
 * through, once saved. sendChatMessage itself never calls computeValidation — it only returns
 * updatedDslContent for the caller to persist through the ordinary PATCH /diagrams/:id ->
 * saveDiagram save path, exactly like any manually-edited DSL content. This test confirms that
 * composition holds for the new User Story 2 diagram-ops (here: setNodeRole), not just the
 * pre-existing base 8 tools.
 */
describe('Standards validation parity for AI-tool-driven mutations (010-ai-diagram-knowledge, T020)', () => {
  let app: FastifyInstance;
  let architectCookie: string;
  let adminCookie: string;
  let projectId: string;

  function toolCallResult(toolName: string, input: Record<string, unknown>) {
    return {
      content: [{ type: 'tool-call' as const, toolCallId: 'mock-t020', toolName, input: JSON.stringify(input) }],
      finishReason: { unified: 'tool-calls' as const, raw: undefined },
      usage: {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
      warnings: [],
    };
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({
      config,
      logger: false,
      // First turn: call setNodeRole on node 'sys' -> 'system'. Every subsequent turn (a tool
      // result is now the last prompt message): finish with plain text, same as noToolCallResult.
      languageModel: new MockLanguageModelV4({
        doGenerate: async (options) => {
          const lastIsToolResult = options.prompt[options.prompt.length - 1]?.role === 'tool';
          if (lastIsToolResult) return noToolCallResult('Done.');
          return toolCallResult('setNodeRole', { nodeId: 'sys', role: 'system' });
        },
      }),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedDiagramType('c4-t020-test', 'c4');
    const architect = await seedUser({ email: 'architect-t020@example.com', password: 'architect-pass' });
    await seedUser({ email: 'admin-t020@example.com', password: 'admin-pass', role: 'admin' });
    projectId = (await seedProject('T020 Project', architect.id)).id;

    const architectLogin = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'architect-t020@example.com', password: 'architect-pass' },
    });
    architectCookie = (Array.isArray(architectLogin.headers['set-cookie']) ? architectLogin.headers['set-cookie'][0] : architectLogin.headers['set-cookie'])!.split(';')[0];

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'admin-t020@example.com', password: 'admin-pass' },
    });
    adminCookie = (Array.isArray(adminLogin.headers['set-cookie']) ? adminLogin.headers['set-cookie'][0] : adminLogin.headers['set-cookie'])!.split(';')[0];

    await getPool().query('UPDATE ai_settings SET chat_enabled = true');

    // Standard: role "system" must use color #1168bd.
    const createStandard = await app.inject({
      method: 'POST',
      url: '/diagram-types/c4-t020-test/standards',
      headers: { cookie: adminCookie },
      payload: { colorPalette: [{ role: 'system', colorHex: '#1168bd' }] },
    });
    const standardId = createStandard.json().standard.id;
    await app.inject({ method: 'POST', url: `/standards/${standardId}/publish`, headers: { cookie: adminCookie } });
  });

  it('flags an AI-set node role identically to the same role set manually, once the chat result is saved', async () => {
    // A Container element (role "container") that already carries the WRONG fill color for what
    // role "system" would require. No violation yet — the palette rule only applies to role
    // "system", and this node isn't that role (yet).
    const initialDsl = 'C4Context\n  Container(sys, "Sys", "desc")\n  UpdateElementStyle(sys, $bgColor="#ff0000")\n';

    const createDiagramResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: architectCookie },
      payload: { name: 'T020 Diagram', diagramTypeId: 'c4-t020-test', initialDslContent: initialDsl },
    });
    expect(createDiagramResponse.statusCode).toBe(201);
    const diagram = createDiagramResponse.json().diagram;
    expect(diagram.lastValidationResult).toEqual([]);

    // AI chat changes the node's role to "system" via the new setNodeRole tool (User Story 2).
    const chatResponse = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'make this a system', currentDslContent: diagram.dslContent },
    });
    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.json().toolCalls).toEqual([{ tool: 'setNodeRole', applied: true }]);

    // Save the AI-updated content through the SAME save path a manual edit would use — no
    // special AI bypass exists, and this test would fail if one were ever introduced.
    const saveResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagram.id}`,
      headers: { cookie: architectCookie },
      payload: { dslContent: chatResponse.json().updatedDslContent },
    });
    expect(saveResponse.statusCode).toBe(200);
    const aiViolations = saveResponse.json().diagram.lastValidationResult;
    expect(aiViolations).toContainEqual(
      expect.objectContaining({ elementId: 'sys', rule: 'color-palette' }),
    );

    // Parity check: manually authoring the SAME end state (role "system", same wrong fill color)
    // on a fresh diagram, through the ordinary create path, produces the IDENTICAL violation.
    const manualDsl = 'C4Context\n  System(sys, "Sys", "desc")\n  UpdateElementStyle(sys, $bgColor="#ff0000")\n';
    const manualDiagramResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: architectCookie },
      payload: { name: 'T020 Manual Diagram', diagramTypeId: 'c4-t020-test', initialDslContent: manualDsl },
    });
    expect(manualDiagramResponse.statusCode).toBe(201);
    expect(manualDiagramResponse.json().diagram.lastValidationResult).toEqual(aiViolations);
  });
});

/**
 * 010-ai-diagram-knowledge, T026 (User Story 4): `buildSystemPrompt`'s composition of a persona's
 * family-scoped-or-unscoped reference material, verified end-to-end through the real
 * `POST /diagrams/:id/chat/messages` route using a mock `LanguageModel` that captures the exact
 * `system` string it was given.
 */
describe('Persona reference material composed into the chat system prompt (010-ai-diagram-knowledge, T026)', () => {
  let app: FastifyInstance;
  let architectCookie: string;
  let projectId: string;
  let capturedSystem: string | undefined;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    config.allowLocalAuth = true;
    await runMigrations();
    app = await buildApp({
      config,
      logger: false,
      languageModel: new MockLanguageModelV4({
        doGenerate: async (options) => {
          const systemMessage = options.prompt.find((m) => m.role === 'system');
          capturedSystem = systemMessage && typeof systemMessage.content === 'string' ? systemMessage.content : undefined;
          return noToolCallResult('Okay, done.');
        },
      }),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    capturedSystem = undefined;
    await resetDatabase();
    await seedDiagramType('erd-refmat-test', 'erd');
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    projectId = (await seedProject('Ref Material Project', architect.id)).id;

    const login = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email: 'architect@example.com', password: 'architect-pass' } });
    architectCookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'])!.split(';')[0];

    await getPool().query('UPDATE ai_settings SET chat_enabled = true');
  });

  async function createPersona(systemPrompt: string): Promise<string> {
    const pool = getPool();
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO ai_personas (name, category, system_prompt) VALUES ('Ref Material Persona', 'Business', $1) RETURNING id",
      [systemPrompt],
    );
    return rows[0].id;
  }

  async function addReferenceMaterial(personaId: string, content: string, diagramFamilies?: string[]): Promise<void> {
    const pool = getPool();
    await pool.query(
      'INSERT INTO ai_persona_reference_material (persona_id, content, diagram_families) VALUES ($1, $2, $3)',
      [personaId, content, diagramFamilies && diagramFamilies.length > 0 ? diagramFamilies : null],
    );
  }

  async function createErdDiagram(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams`,
      headers: { cookie: architectCookie },
      payload: { name: 'Ref Material ERD Diagram', diagramTypeId: 'erd-refmat-test', initialDslContent: 'erDiagram\n' },
    });
    return response.json().diagram.id;
  }

  it(
    'includes family-scoped and unscoped reference material, excludes material scoped to a ' +
      'different family, and orders persona prompt -> primer -> reference material -> diagram summary',
    async () => {
      const erdMarker = 'ERD-SCOPED-MARKER-a1b2c3';
      const c4Marker = 'C4-SCOPED-MARKER-x9y8z7';
      const unscopedMarker = 'UNSCOPED-MARKER-q5w4e3';
      const personaSystemPrompt = 'PERSONA-SYSTEM-PROMPT-m1n2o3';

      const personaId = await createPersona(personaSystemPrompt);
      await addReferenceMaterial(personaId, erdMarker, ['erd']);
      await addReferenceMaterial(personaId, c4Marker, ['c4']);
      await addReferenceMaterial(personaId, unscopedMarker);

      const diagramId = await createErdDiagram();

      const response = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagramId}/chat/messages`,
        headers: { cookie: architectCookie },
        payload: { message: 'hello', currentDslContent: 'erDiagram\n', personaId },
      });
      expect(response.statusCode).toBe(200);
      expect(capturedSystem).toBeDefined();
      const system = capturedSystem as string;

      expect(system).toContain(erdMarker);
      expect(system).toContain(unscopedMarker);
      expect(system).not.toContain(c4Marker);

      const primerSummary = getDiagramTypePrimer('erd')!.summary;
      const personaIdx = system.indexOf(personaSystemPrompt);
      const primerIdx = system.indexOf(primerSummary);
      const erdIdx = system.indexOf(erdMarker);
      const unscopedIdx = system.indexOf(unscopedMarker);
      const summaryIdx = system.indexOf('Current shapes:');

      expect(personaIdx).toBeGreaterThanOrEqual(0);
      expect(primerIdx).toBeGreaterThan(personaIdx);
      expect(erdIdx).toBeGreaterThan(primerIdx);
      expect(unscopedIdx).toBeGreaterThan(primerIdx);
      expect(summaryIdx).toBeGreaterThan(erdIdx);
      expect(summaryIdx).toBeGreaterThan(unscopedIdx);
    },
  );

  it('behaves identically to before this feature for a persona with no reference-material entries at all', async () => {
    const personaSystemPrompt = 'PERSONA-WITH-NO-REFERENCE-MATERIAL';
    const personaId = await createPersona(personaSystemPrompt);
    const diagramId = await createErdDiagram();

    const response = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagramId}/chat/messages`,
      headers: { cookie: architectCookie },
      payload: { message: 'hello', currentDslContent: 'erDiagram\n', personaId },
    });
    expect(response.statusCode).toBe(200);
    expect(capturedSystem).toBeDefined();
    const system = capturedSystem as string;

    const primerSummary = getDiagramTypePrimer('erd')!.summary;
    const expectedSystem = [
      personaSystemPrompt,
      primerSummary,
      'Current shapes:\n(none yet)\n\nCurrent connectors:\n(none yet)',
    ].join('\n\n');
    expect(system).toEqual(expectedSystem);
  });
});
