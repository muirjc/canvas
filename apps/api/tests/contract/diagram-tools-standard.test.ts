import { describe, expect, it } from 'vitest';
import type { DiagramModel } from '@canvas/diagram-core';
import { createDiagramTools, type ToolCallOutcome } from '../../src/ai/diagram-tools.js';
import { C4_CONTEXT_STANDARD, VALUE_CHAIN_STANDARD } from '../../src/seed/reference-standards.seed.js';
import { collectEnumValues } from '../helpers/zod-enums.js';

/** canvas-tfr: the standard-aware AI tool surface (element kinds, connector policy, newViolations). */

function setup(family: string, rules?: Parameters<typeof createDiagramTools>[2]) {
  let model: DiagramModel = { diagramTypeId: family, nodes: [], edges: [], containers: [] };
  const outcomes: ToolCallOutcome[] = [];
  const tools = createDiagramTools(
    { getModel: () => model, setModel: (m) => { model = m; }, recordOutcome: (o) => outcomes.push(o) },
    family,
    rules,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = async (name: string, input: Record<string, unknown>): Promise<any> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tools as any)[name].execute(input, { toolCallId: 't', messages: [] });
  return { tools: tools as Record<string, unknown>, run, outcomes, getModel: () => model };
}

describe('createDiagramTools with a standard -- flowchart (Value Chain)', () => {
  const rules = VALUE_CHAIN_STANDARD;

  it('addElement enum equals the standard kind ids', () => {
    const { tools } = setup('flowchart', rules);
    const values = new Set<string>();
    collectEnumValues((tools.addElement as { inputSchema: unknown }).inputSchema, values);
    expect([...values].sort()).toEqual(rules.elementKinds!.map((k) => k.id).sort());
  });

  it('addElement creates a node with the kind role, shape and fill', async () => {
    const { run, getModel } = setup('flowchart', rules);
    const result = await run('addElement', { kind: 'primary_activity', label: 'Operations' });
    expect(result.applied).toBe(true);
    const node = getModel().nodes.find((n) => n.id === result.nodeId)!;
    expect(node.role).toBe('primary_activity');
    expect(node.shape).toBe('asymmetric');
    expect(node.style?.fillColor).toBe('#dbeafe');
    expect(node.label).toBe('Operations');
  });

  it('setElementKind re-kinds an existing node and reports a missing one', async () => {
    const { run, getModel } = setup('flowchart', rules);
    const { nodeId } = await run('addElement', { kind: 'primary_activity' });
    expect((await run('setElementKind', { nodeId, kind: 'margin' })).applied).toBe(true);
    const node = getModel().nodes.find((n) => n.id === nodeId)!;
    expect(node.role).toBe('margin');
    expect(node.shape).toBe('hexagon');
    const missing = await run('setElementKind', { nodeId: 'nope', kind: 'margin' });
    expect(missing.applied).toBe(false);
  });

  it('omits addNode under requireKnownKinds and restricts style color enums to approved swatches', () => {
    const { tools } = setup('flowchart', rules);
    expect(tools).not.toHaveProperty('addNode');
    const swatches = [...new Set(rules.elementKinds!.flatMap((k) => [...k.approvedFills, ...(k.approvedStrokes ?? [])]))].sort();
    for (const name of ['updateNodeStyle', 'updateEdgeStyle']) {
      const values = new Set<string>();
      collectEnumValues((tools[name] as { inputSchema: unknown }).inputSchema, values);
      expect([...values].sort()).toEqual(swatches);
    }
  });

  it('keeps addNode when the standard does not require known kinds', () => {
    const { tools } = setup('flowchart', { ...rules, requireKnownKinds: false });
    expect(tools).toHaveProperty('addNode');
    expect(tools).toHaveProperty('addElement');
  });

  it("updateNodeStyle rejects a color not approved for the node's own kind and accepts an approved one", async () => {
    const { run, getModel } = setup('flowchart', rules);
    const { nodeId } = await run('addElement', { kind: 'primary_activity' });
    // #fef3c7 is a valid swatch overall (support_activity) but not approved for primary_activity.
    const rejected = await run('updateNodeStyle', { nodeId, fillColor: '#fef3c7' });
    expect(rejected.applied).toBe(false);
    expect(rejected.reason).toContain('#dbeafe');
    expect(rejected.reason).toContain('#bfdbfe');
    expect(getModel().nodes[0].style?.fillColor).toBe('#dbeafe');

    const rejectedStroke = await run('updateNodeStyle', { nodeId, strokeColor: '#b45309' });
    expect(rejectedStroke.applied).toBe(false);

    const accepted = await run('updateNodeStyle', { nodeId, fillColor: '#bfdbfe' });
    expect(accepted.applied).toBe(true);
    expect(getModel().nodes[0].style?.fillColor).toBe('#bfdbfe');
  });

  it('addEdge: listed-only rejects support_activity -> margin; primary -> primary gets rule defaults', async () => {
    const { run, getModel } = setup('flowchart', rules);
    const support = (await run('addElement', { kind: 'support_activity' })).nodeId;
    const margin = (await run('addElement', { kind: 'margin' })).nodeId;
    const p1 = (await run('addElement', { kind: 'primary_activity' })).nodeId;
    const p2 = (await run('addElement', { kind: 'primary_activity' })).nodeId;

    const rejected = await run('addEdge', { sourceId: support, targetId: margin });
    expect(rejected.applied).toBe(false);
    expect(rejected.reason).toContain('Allowed');
    expect(rejected.reason).toContain('primary_activity -> primary_activity');
    expect(getModel().edges).toHaveLength(0);

    const ok = await run('addEdge', { sourceId: p1, targetId: p2 });
    expect(ok.applied).toBe(true);
    const edge = getModel().edges[0];
    expect(edge.sourceId).toBe(p1);
    expect(edge.targetId).toBe(p2);
    expect(edge.lineStyle ?? 'solid').toBe('solid');
    expect(edge.arrow ?? 'target').toBe('target');
  });

  it('reports newViolations for violations introduced by the call, and only those', async () => {
    const { run, outcomes } = setup('flowchart', rules);
    await run('addElement', { kind: 'margin' });
    // A second margin introduces kind-max-count (maxCount 1).
    const second = await run('addElement', { kind: 'margin' });
    expect(second.applied).toBe(true);
    expect(second.newViolations).toBeDefined();
    expect(second.newViolations.length).toBeLessThanOrEqual(5);
    expect(second.newViolations.map((v: { rule: string }) => v.rule)).toContain('kind-max-count');
    for (const v of second.newViolations) {
      expect(Object.keys(v).sort()).toEqual(['elementId', 'message', 'rule', 'severity']);
    }

    // An unconnected primary introduces kind-unconnected.
    const primary = await run('addElement', { kind: 'primary_activity' });
    expect(primary.newViolations.map((v: { rule: string }) => v.rule)).toContain('kind-unconnected');

    // Relabeling introduces nothing new: no newViolations key at all.
    const relabel = await run('updateNodeLabel', { nodeId: primary.nodeId, label: 'Renamed' });
    expect(relabel.applied).toBe(true);
    expect(relabel).not.toHaveProperty('newViolations');

    // The recorded outcome stays narrow.
    for (const o of outcomes) {
      expect(Object.keys(o).every((k) => ['tool', 'applied', 'reason'].includes(k))).toBe(true);
    }
  });

  it('does not attach newViolations to a rejected call', async () => {
    const { run } = setup('flowchart', rules);
    const { nodeId } = await run('addElement', { kind: 'primary_activity' });
    const rejected = await run('updateNodeStyle', { nodeId, fillColor: '#fef3c7' });
    expect(rejected).not.toHaveProperty('newViolations');
  });
});

describe('createDiagramTools with a standard -- c4 (C4 Context)', () => {
  const rules = C4_CONTEXT_STANDARD;

  it('omits setNodeRole when kinds are defined', () => {
    const { tools } = setup('c4', rules);
    expect(tools).not.toHaveProperty('setNodeRole');
    expect(tools).toHaveProperty('addElement');
    expect(tools).not.toHaveProperty('addNode');
  });

  it("addElement('external_system') yields role system and external true", async () => {
    const { run, getModel } = setup('c4', rules);
    const result = await run('addElement', { kind: 'external_system', label: 'Payments' });
    const node = getModel().nodes.find((n) => n.id === result.nodeId)!;
    expect(node.role).toBe('system');
    expect(node.external).toBe(true);
    expect(node.style?.fillColor).toBe('#999999');
  });
});

describe('createDiagramTools without rules', () => {
  it.each(['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml'])(
    'tool set for %s is identical with rules omitted or undefined',
    (family) => {
      const model: DiagramModel = { diagramTypeId: family, nodes: [], edges: [], containers: [] };
      const ctx = { getModel: () => model, setModel: () => {} };
      const a = Object.keys(createDiagramTools(ctx, family)).sort();
      const b = Object.keys(createDiagramTools(ctx, family, undefined)).sort();
      expect(a).toEqual(b);
      expect(a).not.toContain('addElement');
      expect(a).not.toContain('setElementKind');
    },
  );

  it('does not add newViolations without rules', async () => {
    const { run } = setup('flowchart');
    const r = await run('addNode', { shape: 'rectangle' });
    expect(r).not.toHaveProperty('newViolations');
  });
});
