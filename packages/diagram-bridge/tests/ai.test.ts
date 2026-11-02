import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { asSchema } from '@ai-sdk/provider-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDiagramTools } from '../../../apps/api/src/ai/diagram-tools.js';
import { getDiagramTypePrimer } from '../../../apps/api/src/ai/diagram-type-primers.js';
import { describeModel } from '../../../apps/api/src/ai/describe-model.js';
import { buildStandardPrompt } from '../../../apps/api/src/ai/standard-prompt.js';
import { createBridgeServer } from '../src/server.js';

/** canvas-1bty.12: the AI ops serve exactly what apps/api's createDiagramTools and prompt builders produce. */
const FAMILIES = ['flowchart', 'c4', 'sequence', 'erd', 'uml', 'architecture'];

// A standard with element kinds (flowchart family carries them as classes), so the tool set changes.
const RULES = {
  allowedShapeIds: [],
  mandatoryShapeIds: [],
  allowedIconLibraryRefs: [],
  colorPalette: [],
  requireKnownKinds: true,
  elementKinds: [
    { id: 'primary_activity', label: 'Primary Activity', description: 'Creates value.', shapes: ['asymmetric'], approvedFills: ['#dbeafe'], approvedStrokes: ['#1d4ed8'], minCount: 1 },
    { id: 'margin', label: 'Margin', description: 'The value captured.', shapes: ['hexagon'], approvedFills: ['#dcfce7'], maxCount: 1 },
  ],
  guidance: 'Chain activities left to right.',
};

describe('diagram-core bridge: AI ops', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createBridgeServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = async (op: string, body: unknown) => {
    const res = await fetch(`${base}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed bridge responses
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const parse = async (family: string, dsl: string) => (await post('parse', { family, dsl })).json.model;

  async function expectedTools(family: string, rules?: typeof RULES) {
    const tools = createDiagramTools({ getModel: () => ({}) as never, setModel: () => undefined }, family, rules as never) as unknown as Record<
      string,
      { description?: string; inputSchema: Parameters<typeof asSchema>[0] }
    >;
    return Promise.all(
      Object.entries(tools).map(async ([name, t]) => ({ name, description: t.description ?? '', inputSchema: await asSchema(t.inputSchema).jsonSchema })),
    );
  }

  describe('ai-tools', () => {
    it.each(FAMILIES)('offers %s the same tools, descriptions and JSON schemas as createDiagramTools', async (family) => {
      const { status, json } = await post('ai-tools', { family });
      expect(status).toBe(200);
      expect(json.tools.length).toBeGreaterThan(0);
      expect(json.tools).toEqual(await expectedTools(family));
    });

    it.each(FAMILIES)('with a standard, %s gets the tools createDiagramTools builds for it', async (family) => {
      const { json } = await post('ai-tools', { family, rules: RULES });
      expect(json.tools).toEqual(await expectedTools(family, RULES));
    });

    it('a standard with element kinds adds addElement for the flowchart family', async () => {
      const without = (await post('ai-tools', { family: 'flowchart' })).json.tools.map((t: { name: string }) => t.name);
      const withKinds = (await post('ai-tools', { family: 'flowchart', rules: RULES })).json.tools.map((t: { name: string }) => t.name);
      expect(without).not.toContain('addElement');
      expect(withKinds).toContain('addElement');
    });

    it('rejects an unknown family', async () => {
      expect((await post('ai-tools', { family: 'gantt' })).status).toBe(400);
    });
  });

  describe('ai-tool', () => {
    it('runs a tool: the model changes and the outcome is recorded', async () => {
      const model = await parse('flowchart', 'flowchart TD\n');
      const { status, json } = await post('ai-tool', { family: 'flowchart', model, name: 'addNode', input: { shape: 'rectangle', label: 'Start' } });
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.model.nodes.map((n: { label: string }) => n.label)).toEqual(['Start']);
      expect(json.outcomes).toEqual([{ tool: 'addNode', applied: true }]);
      expect(json.output).toMatchObject({ applied: true, nodeId: json.model.nodes[0].id });
    });

    it('records a not-applied outcome with its reason, leaving the model alone', async () => {
      const model = await parse('flowchart', 'flowchart TD\n  A[One]\n');
      const { json } = await post('ai-tool', { family: 'flowchart', model, name: 'removeNode', input: { nodeId: 'missing' } });
      expect(json.ok).toBe(true);
      expect(json.model).toEqual(model);
      expect(json.outcomes).toEqual([expect.objectContaining({ tool: 'removeNode', applied: false, reason: expect.any(String) })]);
    });

    it('works on another family (setNodeRole on c4)', async () => {
      const model = await parse('c4', 'C4Context\n  Container(sys, "Sys", "desc")\n');
      const { json } = await post('ai-tool', { family: 'c4', model, name: 'setNodeRole', input: { nodeId: 'sys', role: 'system' } });
      expect(json.ok).toBe(true);
      expect(json.model.nodes[0].role).toBe('system');
      expect(json.outcomes).toEqual([{ tool: 'setNodeRole', applied: true }]);
    });

    it('reports input that does not fit the schema as { ok: false, error }', async () => {
      const model = await parse('flowchart', 'flowchart TD\n');
      const { status, json } = await post('ai-tool', { family: 'flowchart', model, name: 'addNode', input: { shape: 'not-a-shape' } });
      expect(status).toBe(200);
      expect(json.ok).toBe(false);
      expect(json.error).toMatch(/^Invalid input for tool addNode: /);
    });

    it('reports an unknown tool, naming the tools that are available', async () => {
      const model = await parse('flowchart', 'flowchart TD\n');
      const { json } = await post('ai-tool', { family: 'flowchart', model, name: 'setEntityAttributes', input: {} });
      expect(json.ok).toBe(false);
      expect(json.error).toContain("unavailable tool 'setEntityAttributes'");
      expect(json.error).toContain('addNode');
    });

    it('does not treat an Object prototype key as a tool', async () => {
      const model = await parse('flowchart', 'flowchart TD\n');
      const { json } = await post('ai-tool', { family: 'flowchart', model, name: 'constructor', input: {} });
      expect(json.ok).toBe(false);
    });

    it('reports an error thrown inside a tool as { ok: false, error }', async () => {
      const model = await parse('flowchart', 'flowchart TD\n  A[One]\n');
      const { status, json } = await post('ai-tool', { family: 'flowchart', model, name: 'updateNodeLabel', input: { nodeId: 'A', label: '' } });
      expect(status).toBe(200);
      expect(json).toEqual({ ok: false, error: 'updateNodeLabel: shape labels must be non-empty' });
    });
  });

  describe('ai-prompt', () => {
    it('returns the family primer, no standard, and the current-diagram summary', async () => {
      const model = await parse('erd', 'erDiagram\n  CUSTOMER {\n    string name\n  }\n');
      const { status, json } = await post('ai-prompt', { family: 'erd', model });
      expect(status).toBe(200);
      expect(json.primer).toBe(getDiagramTypePrimer('erd')!.summary);
      expect(json.standard).toBeNull();
      expect(json.currentDiagram).toBe(describeModel(model));
      expect(json.currentDiagram).toContain('CUSTOMER');
    });

    it('an empty diagram says so', async () => {
      const model = await parse('flowchart', 'flowchart TD\n');
      const { json } = await post('ai-prompt', { family: 'flowchart', model });
      expect(json.currentDiagram).toBe('Current shapes:\n(none yet)\n\nCurrent connectors:\n(none yet)');
    });

    it('with a standard, adds the standard section and kinds/violations to the summary', async () => {
      const model = await parse('flowchart', 'flowchart TD\n  A[Ops]:::primary_activity\n');
      const { json } = await post('ai-prompt', { family: 'flowchart', rules: RULES, model });
      expect(json.standard).toBe(buildStandardPrompt(RULES as never, 'flowchart'));
      expect(json.standard).toContain('primary_activity');
      expect(json.currentDiagram).toBe(describeModel(model, RULES as never));
      expect(json.currentDiagram).toContain('kind: primary_activity');
    });
  });
});
