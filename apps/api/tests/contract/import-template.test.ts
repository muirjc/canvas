import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, resetDatabase, seedProject, seedUser } from '../helpers/setup.js';
import { getPool } from '../../src/db/pool.js';

/**
 * Contract for POST /projects/:projectId/diagrams/import-template — importing a filled-in
 * Markdown "intake template" (docs/c4-context-template.md) as a new diagram, distinct from raw
 * DSL import (import.test.ts) in that `diagramTypeId` is a required input rather than
 * auto-detected. Mirrors import.test.ts's own harness/seeding pattern exactly.
 */
describe('Import Template API contract', () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let projectId: string;

  // Matches docs/c4-context-template.md's own worked example (central system OrderService,
  // entities Customer/Payment Gateway, 2 relationships) so the expected compiled DSL is easy to
  // cross-check against the doc.
  const VALID_TEMPLATE = [
    '# C4 Context Diagram — Intake Template',
    '',
    '## 1. Diagram metadata',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Diagram title | Order Service Context |',
    '| Central system name | OrderService |',
    '| Central system description (one line) | Handles order creation and fulfillment |',
    '| Central system technology (optional) | |',
    '',
    '## 2. Boundaries (optional)',
    '',
    '| Boundary name | Type (Enterprise / System) | Entities inside |',
    '|---|---|---|',
    '| | | |',
    '',
    '## 3. Surrounding entities',
    '',
    '| Name | Type | Internal/External | Description (one line) | Technology (optional) |',
    '|---|---|---|---|---|',
    '| Customer | Person | Internal | Places and tracks orders | |',
    '| Payment Gateway | System | External | Processes credit card payments | |',
    '',
    '## 4. Relationships',
    '',
    '| From | To | Label (short verb phrase) | Technology/protocol (optional) |',
    '|---|---|---|---|',
    '| Customer | OrderService | Places orders using | HTTPS |',
    '| OrderService | Payment Gateway | Sends payment requests to | HTTPS/JSON |',
    '',
    '## 5. Styling notes (optional)',
    '',
    '| Entity name | Background color | Font color | Border color |',
    '|---|---|---|---|',
    '| | | | |',
    '',
  ].join('\n');

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
    // Owned by the acting user: projects became access-controlled in feature 007, so a fixture
    // project must name who works in it.
    projectId = (await seedProject('Test Project', architect.id)).id;
    const response = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'architect@example.com', password: 'architect-pass' },
    });
    const setCookie = response.headers['set-cookie'];
    sessionCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  });

  it('imports a filled C4 Context template and compiles it to the expected DSL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Order Service Context', diagramTypeId: 'c4-context', templateContent: VALID_TEMPLATE },
    });
    expect(response.statusCode).toBe(201);
    const { diagram } = response.json();
    expect(diagram.diagramTypeId).toBe('c4-context');
    expect(diagram.dslContent).toContain('System(orderService,');
    expect(diagram.dslContent).toContain('Person(customer,');
    expect(diagram.dslContent).toContain('System_Ext(paymentGateway,');
    expect(diagram.dslContent).toContain('Rel(customer, orderService,');
  });

  it('rejects a malformed template with structured 422 details', async () => {
    // Omit "Central system name" from section 1 — a required field the compiler checks for.
    const malformed = VALID_TEMPLATE.replace('| Central system name | OrderService |', '| Central system name | |');
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Bad Template', diagramTypeId: 'c4-context', templateContent: malformed },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe('Template could not be compiled');
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details[0]).toHaveProperty('line');
    expect(body.details[0]).toHaveProperty('content');
    expect(body.details[0]).toHaveProperty('message');
  });

  it('rejects an unrecognized entity Type in the entities table with structured 422 details', async () => {
    const malformed = VALID_TEMPLATE.replace(
      '| Customer | Person | Internal | Places and tracks orders | |',
      '| Customer | Human | Internal | Places and tracks orders | |',
    );
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Bad Type', diagramTypeId: 'c4-context', templateContent: malformed },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details[0].message).toContain('Human');
  });

  it('rejects a diagram type with no registered template compiler, with no details key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: sessionCookie },
      payload: { name: 'Unsupported', diagramTypeId: 'sequence', templateContent: VALID_TEMPLATE },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(typeof body.error).toBe('string');
    expect(body.details).toBeUndefined();
  });

  it('rejects a request missing name with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: sessionCookie },
      payload: { diagramTypeId: 'c4-context', templateContent: VALID_TEMPLATE },
    });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('rejects a request missing diagramTypeId with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: sessionCookie },
      payload: { name: 'No Type', templateContent: VALID_TEMPLATE },
    });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('rejects a request missing templateContent with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: sessionCookie },
      payload: { name: 'No Content', diagramTypeId: 'c4-context' },
    });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      payload: { name: 'Trespass', diagramTypeId: 'c4-context', templateContent: VALID_TEMPLATE },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a signed-in user with no access to the project with 403', async () => {
    await seedUser({ email: 'outsider@example.com', password: 'outsider-pass' });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: 'outsider@example.com', password: 'outsider-pass' },
    });
    const setCookie = loginResponse.headers['set-cookie'];
    const outsiderCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/diagrams/import-template`,
      headers: { cookie: outsiderCookie },
      payload: { name: 'Trespass', diagramTypeId: 'c4-context', templateContent: VALID_TEMPLATE },
    });
    expect(response.statusCode).toBe(403);
  });
});
