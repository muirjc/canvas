import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  closeTestDb,
  resetDatabase,
  seedDiagramType,
  seedFlowchartDiagramType,
  seedProject,
  seedUser,
} from '../helpers/setup.js';

/**
 * canvas-tfr: Standards v2 (element kinds, connector rules, guidance, severity overrides) over the
 * standards HTTP API -- create/edit/clone/validate/retire.
 */
const V2_BODY = {
  name: 'Process Map Rules',
  description: 'Kinds for process maps.',
  requireKnownKinds: true,
  connectorPolicy: 'listed-only',
  elementKinds: [
    { id: 'step', label: 'Step', shapes: ['rectangle'], approvedFills: ['#dbeafe'], minCount: 2 },
    { id: 'decision', label: 'Decision', shapes: ['diamond'], approvedFills: [], maxCount: 3 },
  ],
  connectorRules: [{ id: 'flow', label: 'Flow', from: 'step', to: '*', lineStyles: ['solid'], maxPerSource: 2 }],
  severityOverrides: { 'kind-min-count': 'error', 'unknown-kind': 'error' },
  guidance: 'Every step flows onward.',
};

describe('Standards v2 API contract', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let architectCookie: string;
  let architectId: string;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function login(email: string, password: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    const setCookie = response.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];
  }

  const create = (payload: unknown, typeId = 'flowchart', cookie = adminCookie) =>
    app.inject({ method: 'POST', url: `/diagram-types/${typeId}/standards`, headers: { cookie }, payload: payload as object });
  const post = (url: string, cookie = adminCookie) => app.inject({ method: 'POST', url, headers: { cookie } });

  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    await seedUser({ email: 'admin@example.com', password: 'admin-pass', role: 'admin' });
    architectId = (await seedUser({ email: 'architect@example.com', password: 'architect-pass', role: 'architect' })).id;
    adminCookie = await login('admin@example.com', 'admin-pass');
    architectCookie = await login('architect@example.com', 'architect-pass');
  });

  describe('create and read', () => {
    it('persists v2 rules intact and returns them from the list and the active standard', async () => {
      const response = await create(V2_BODY);
      expect(response.statusCode).toBe(201);
      const { standard } = response.json();
      expect(standard.name).toBe('Process Map Rules');
      expect(standard.rules.elementKinds).toHaveLength(2);

      await post(`/standards/${standard.id}/publish`);

      const active = (
        await app.inject({ method: 'GET', url: '/diagram-types/flowchart/standard', headers: { cookie: architectCookie } })
      ).json().standard;
      const list = (
        await app.inject({ method: 'GET', url: '/diagram-types/flowchart/standards', headers: { cookie: adminCookie } })
      ).json().standards;

      for (const rules of [active.rules, list[0].rules]) {
        expect(rules.elementKinds).toEqual([
          expect.objectContaining({ id: 'step', label: 'Step', shapes: ['rectangle'], approvedFills: ['#dbeafe'], minCount: 2 }),
          expect.objectContaining({ id: 'decision', shapes: ['diamond'], maxCount: 3 }),
        ]);
        expect(rules.connectorRules).toEqual([expect.objectContaining({ id: 'flow', from: 'step', to: '*', maxPerSource: 2 })]);
        expect(rules.connectorPolicy).toBe('listed-only');
        expect(rules.requireKnownKinds).toBe(true);
        expect(rules.severityOverrides).toEqual({ 'kind-min-count': 'error', 'unknown-kind': 'error' });
        expect(rules.guidance).toBe('Every step flows onward.');
      }
    });

    it('still accepts a v1-only body (back-compat) and returns no v2 fields', async () => {
      const response = await create({ allowedShapeIds: ['rectangle'], colorPalette: [{ role: 'system', colorHex: '#1168bd' }] });
      expect(response.statusCode).toBe(201);
      const { rules } = response.json().standard;
      expect(rules.allowedShapeIds).toEqual(['rectangle']);
      expect(rules.colorPalette).toEqual([{ role: 'system', colorHex: '#1168bd' }]);
      expect(rules.elementKinds).toBeUndefined();
      expect(rules.connectorRules).toBeUndefined();
    });

    it('returns 404 for an unknown diagram type', async () => {
      const response = await create(V2_BODY, 'no-such-type');
      expect(response.statusCode).toBe(404);
    });
  });

  describe('definition validation', () => {
    it('rejects an invalid kind id with 400 and a path-bearing issue', async () => {
      const response = await create({ elementKinds: [{ id: 'Bad-Id', label: 'Bad', shapes: ['rectangle'], approvedFills: [] }] });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBeTruthy();
      expect(body.issues.length).toBeGreaterThan(0);
      expect(body.issues[0]).toEqual({ path: expect.any(String), message: expect.any(String) });
      expect(body.issues.some((i: { path: string }) => i.path.includes('elementKinds'))).toBe(true);
    });

    it("rejects a shape the flowchart family can't draw ('person')", async () => {
      const response = await create({ elementKinds: [{ id: 'who', label: 'Who', shapes: ['person'], approvedFills: [] }] });
      expect(response.statusCode).toBe(400);
      expect(response.json().issues.some((i: { path: string }) => i.path.includes('shapes'))).toBe(true);
    });

    it('rejects a connector rule that references an unknown kind', async () => {
      const response = await create({
        elementKinds: [{ id: 'step', label: 'Step', shapes: ['rectangle'], approvedFills: [] }],
        connectorRules: [{ id: 'flow', label: 'Flow', from: 'step', to: 'ghost' }],
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().issues.some((i: { path: string }) => i.path.includes('connectorRules'))).toBe(true);
    });

    it('rejects a structurally invalid body (wrong type) with 400 issues', async () => {
      const response = await create({ elementKinds: 'nope' });
      expect(response.statusCode).toBe(400);
      expect(response.json().issues[0].path).toBe('elementKinds');
    });

    it('persists nothing when validation fails', async () => {
      await create({ elementKinds: [{ id: 'Bad-Id', label: 'Bad', shapes: [], approvedFills: [] }] });
      const list = (
        await app.inject({ method: 'GET', url: '/diagram-types/flowchart/standards', headers: { cookie: adminCookie } })
      ).json().standards;
      expect(list).toEqual([]);
    });
  });

  describe('PUT /standards/:id', () => {
    it('edits a draft in place (rules and name)', async () => {
      const { standard } = (await create(V2_BODY)).json();
      const response = await app.inject({
        method: 'PUT',
        url: `/standards/${standard.id}`,
        headers: { cookie: adminCookie },
        payload: { ...V2_BODY, name: 'Renamed', guidance: 'New guidance', elementKinds: [V2_BODY.elementKinds[0]], connectorRules: [] },
      });
      expect(response.statusCode).toBe(200);
      const updated = response.json().standard;
      expect(updated.id).toBe(standard.id);
      expect(updated.version).toBe(standard.version);
      expect(updated.name).toBe('Renamed');
      expect(updated.status).toBe('draft');
      expect(updated.rules.guidance).toBe('New guidance');
      expect(updated.rules.elementKinds).toHaveLength(1);

      const list = (
        await app.inject({ method: 'GET', url: '/diagram-types/flowchart/standards', headers: { cookie: adminCookie } })
      ).json().standards;
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Renamed');
      expect(list[0].rules.elementKinds).toHaveLength(1);
    });

    it('rejects an invalid edit with 400 and leaves the draft unchanged', async () => {
      const { standard } = (await create(V2_BODY)).json();
      const response = await app.inject({
        method: 'PUT',
        url: `/standards/${standard.id}`,
        headers: { cookie: adminCookie },
        payload: { elementKinds: [{ id: 'Bad-Id', label: 'x', shapes: [], approvedFills: [] }] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().issues.length).toBeGreaterThan(0);
      const list = (
        await app.inject({ method: 'GET', url: '/diagram-types/flowchart/standards', headers: { cookie: adminCookie } })
      ).json().standards;
      expect(list[0].rules.elementKinds).toHaveLength(2);
    });

    it('returns 409 for a published standard', async () => {
      const { standard } = (await create(V2_BODY)).json();
      await post(`/standards/${standard.id}/publish`);
      const response = await app.inject({
        method: 'PUT',
        url: `/standards/${standard.id}`,
        headers: { cookie: adminCookie },
        payload: V2_BODY,
      });
      expect(response.statusCode).toBe(409);
    });

    it('returns 404 for an unknown standard', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/standards/00000000-0000-0000-0000-000000000000',
        headers: { cookie: adminCookie },
        payload: V2_BODY,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /standards/:id/clone', () => {
    it('clones a published standard into a new draft at the next version with the same rules', async () => {
      const { standard } = (await create(V2_BODY)).json();
      await post(`/standards/${standard.id}/publish`);

      const response = await post(`/standards/${standard.id}/clone`);
      expect(response.statusCode).toBe(201);
      const clone = response.json().standard;
      expect(clone.id).not.toBe(standard.id);
      expect(clone.status).toBe('draft');
      expect(clone.version).toBe(standard.version + 1);
      expect(clone.name).toBe('Process Map Rules (copy)');
      expect(clone.description).toBe('Kinds for process maps.');
      expect(clone.rules.elementKinds).toEqual(standard.rules.elementKinds);
      expect(clone.rules.connectorRules).toEqual(standard.rules.connectorRules);
      expect(clone.rules.severityOverrides).toEqual(standard.rules.severityOverrides);
      expect(clone.rules.guidance).toBe(standard.rules.guidance);

      // The published original is untouched and still the active standard.
      const active = (
        await app.inject({ method: 'GET', url: '/diagram-types/flowchart/standard', headers: { cookie: adminCookie } })
      ).json().standard;
      expect(active.id).toBe(standard.id);
    });

    it('copies v1 shapes and palette too', async () => {
      const { standard } = (await create({ allowedShapeIds: ['rectangle', 'circle'], mandatoryShapeIds: ['rectangle'] })).json();
      const clone = (await post(`/standards/${standard.id}/clone`)).json().standard;
      expect(clone.rules.allowedShapeIds.sort()).toEqual(['circle', 'rectangle']);
      expect(clone.rules.mandatoryShapeIds).toEqual(['rectangle']);
    });

    it('returns 404 for an unknown standard', async () => {
      const response = await post('/standards/00000000-0000-0000-0000-000000000000/clone');
      expect(response.statusCode).toBe(404);
    });
  });

  describe('authorization', () => {
    it('returns 403 for a non-admin on create, edit and clone', async () => {
      const { standard } = (await create(V2_BODY)).json();
      expect((await create(V2_BODY, 'flowchart', architectCookie)).statusCode).toBe(403);
      const put = await app.inject({
        method: 'PUT',
        url: `/standards/${standard.id}`,
        headers: { cookie: architectCookie },
        payload: V2_BODY,
      });
      expect(put.statusCode).toBe(403);
      expect((await post(`/standards/${standard.id}/clone`, architectCookie)).statusCode).toBe(403);
    });
  });

  describe('validation of saved diagrams against v2 rules', () => {
    // `class <ids> <kind>` assigns a node its element kind (flowchart-parser: first class == role).
    const DSL = 'flowchart TD\n  A --> B\n  class A step\n';

    async function createDiagram(typeId: string): Promise<{ id: string; lastValidationResult: Array<{ rule: string; severity: string }> }> {
      const project = await seedProject('P', architectId);
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/diagrams`,
        headers: { cookie: architectCookie },
        payload: { name: 'D', diagramTypeId: typeId, initialDslContent: DSL },
      });
      expect(response.statusCode).toBe(201);
      return response.json().diagram;
    }

    async function publishV2(typeId: string): Promise<string> {
      const { standard } = (await create(V2_BODY, typeId)).json();
      expect((await post(`/standards/${standard.id}/publish`)).statusCode).toBe(200);
      return standard.id;
    }

    async function fetchResult(id: string) {
      const response = await app.inject({ method: 'GET', url: `/diagrams/${id}`, headers: { cookie: architectCookie } });
      return response.json().diagram.lastValidationResult as Array<{ rule: string; severity: string; elementId: string }>;
    }

    async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
      const deadline = Date.now() + 5000;
      let value = await read();
      while (!done(value) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        value = await read();
      }
      return value;
    }

    it('flags v2 violations on a new diagram with the overridden severity', async () => {
      await seedDiagramType('value-chain', 'flowchart', 'Value Chain');
      await publishV2('value-chain');
      const diagram = await createDiagram('value-chain');

      expect(diagram.lastValidationResult).toContainEqual(
        expect.objectContaining({ rule: 'kind-min-count', severity: 'error', elementId: '(diagram)' }),
      );
      // B has no kind and requireKnownKinds is on.
      expect(diagram.lastValidationResult).toContainEqual(
        expect.objectContaining({ rule: 'unknown-kind', severity: 'error', elementId: 'B' }),
      );
    });

    it('revalidates existing diagrams when a v2 standard is published', async () => {
      await seedDiagramType('value-chain', 'flowchart', 'Value Chain');
      const diagram = await createDiagram('value-chain');
      expect(diagram.lastValidationResult).toEqual([]);
      await publishV2('value-chain');
      const result = await waitFor(() => fetchResult(diagram.id), (r) => r.length > 0);
      expect(result.map((v) => v.rule)).toContain('kind-min-count');
    });

    it('clears cached violations after the standard is retired', async () => {
      await seedDiagramType('value-chain', 'flowchart', 'Value Chain');
      const standardId = await publishV2('value-chain');
      const diagram = await createDiagram('value-chain');
      expect(diagram.lastValidationResult.length).toBeGreaterThan(0);

      expect((await post(`/standards/${standardId}/retire`)).statusCode).toBe(200);
      const result = await waitFor(() => fetchResult(diagram.id), (r) => r.length === 0);
      expect(result).toEqual([]);
    });
  });
});
