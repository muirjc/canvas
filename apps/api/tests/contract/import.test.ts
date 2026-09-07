import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedProject, seedUser } from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';

/**
 * Contract for POST /projects/:id/diagrams/import per contracts/api-diagrams.md. Covers User
 * Story 5: FR-018 (import creates a fully editable diagram) and FR-019 (structured errors for
 * unmappable syntax, never a silent failure).
 */
describe('Import API contract', () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let projectId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDatabase();
    const pool = getPool();
    await pool.query(
      `INSERT INTO diagram_types (id, name, personas, abstraction_level, dsl_family, default_palette_library_ids)
       VALUES
         ('flowchart', 'Generic Flowchart', ARRAY['Business','Enterprise','Solution','Technical'], 'N/A', 'flowchart', ARRAY['generic']),
         ('c4-context', 'C4 Context', ARRAY['Technical'], 'Context', 'c4', ARRAY['c4-notation']),
         ('sequence', 'Sequence Diagram', ARRAY['Solution','Technical'], 'N/A', 'sequence', ARRAY['generic'])`,
    );
    const architect = await seedUser({ email: 'architect@example.com', password: 'architect-pass' });
    // Owned by the acting user: projects became access-controlled in feature 007, so a
    // fixture project must name who works in it.
    projectId = (await seedProject('Test Project', architect.id)).id;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'architect@example.com', password: 'architect-pass' },
    });
    const setCookie = response.headers['set-cookie'];
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  it('imports a valid flowchart with no hint (auto-detected)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Imported Flowchart', dslContent: 'flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().diagram.diagramTypeId).toBe('flowchart');
  });

  it('imports a "graph" header with style directives and comments (User Story 5)', async () => {
    const dslContent = [
      'graph TD',
      '    A[🚀 Welcome to Playground] --> B{Try Mermaid}',
      '    %% this is a comment',
      '    B -->|Edit Code| C[📝 Live Preview]',
      '    B -->|Love It?| D[✨ Sign Up]',
      '    C --> E[🎯 See Changes Instantly]',
      '    D --> F[💾 Save & Export]',
      '',
      '    style A fill:#e1f5fe',
      '    style D fill:#f3e5f5',
      '    style F fill:#e8f5e8',
      '',
    ].join('\n');
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Imported Graph Alias', dslContent },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().diagram.diagramTypeId).toBe('flowchart');
  });

  it('imports a valid sequence diagram and resolves the right diagram type without a hint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Imported Sequence', dslContent: 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: Hi\n' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().diagram.diagramTypeId).toBe('sequence');
  });

  it('honors an explicit diagramTypeHint that matches the detected family', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: {
        name: 'Imported C4',
        dslContent: 'C4Context\nPerson(user, "User")\n',
        diagramTypeHint: 'c4-context',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().diagram.diagramTypeId).toBe('c4-context');
  });

  // jmuir-dtu.15: detectDslFamily's C4 pattern never included the "Deployment" header variant, so
  // a raw C4Deployment paste failed family detection entirely (before parseC4 -- which has
  // supported C4Deployment since jmuir-dtu.3.2 -- was ever reached) and could not be imported
  // without a hint. Only "c4-context" is seeded as a c4-family diagram_types row in this test file,
  // so a no-hint import correctly falls back to it (auto-resolution picks any row sharing the
  // detected "c4" dsl_family, per import.service.ts) -- what this test actually proves is that
  // detection/parsing succeeds at all, not which specific c4-* diagramTypeId is chosen.
  it('imports a valid C4Deployment diagram and resolves a c4-family diagram type without a hint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: {
        name: 'Imported C4 Deployment',
        dslContent: 'C4Deployment\n  Deployment_Node(live, "Live") {\n  }\n',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().diagram.diagramTypeId).toBe('c4-context');
  });

  it('rejects a hint whose DSL family does not match the content', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: {
        name: 'Mismatched',
        dslContent: 'flowchart TD\n  A[Start]\n',
        diagramTypeHint: 'c4-context',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toContain('flowchart');
  });

  it('rejects unrecognized text with a specific, non-silent error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Garbage', dslContent: 'this is not any known diagram syntax at all\n' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBeTruthy();
  });

  it('rejects a recognized header with unmappable content inside, with structured details', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Partially Bad', dslContent: 'flowchart TD\n  ???not-valid-syntax???\n' },
    });
    expect(response.statusCode).toBe(422);
    expect(Array.isArray(response.json().details)).toBe(true);
    expect(response.json().details[0]).toHaveProperty('line');
  });

  it('imported diagrams are fully editable/exportable afterward like native ones', async () => {
    const importResponse = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Round Trip Import', dslContent: 'flowchart TD\n  A[Start]\n' },
    });
    const diagram = importResponse.json().diagram;

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/diagrams/${diagram.id}`,
      headers: { cookie: sessionCookie },
      payload: { dslContent: 'flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n' },
    });
    expect(patchResponse.statusCode).toBe(200);

    const exportResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/export?format=svg`,
      headers: { cookie: sessionCookie },
    });
    expect(exportResponse.statusCode).toBe(200);
  });
});
