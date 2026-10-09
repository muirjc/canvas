import { describe, expect, it } from 'vitest';
import { addElementOfKind, applyConnectorRule, applyElementKind } from '../../src/model/standard-ops.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import type { ConnectorRule, ElementKind } from '../../src/standards/schema.js';

// canvas-tfr: pure model operations that apply a standard's element kinds / connector rules.

const empty = (): DiagramModel => ({ diagramTypeId: 'flowchart', nodes: [], edges: [], containers: [] });
const kind = (over: Partial<ElementKind> = {}): ElementKind => ({
  id: 'primary_activity',
  label: 'Primary Activity',
  shapes: ['rounded-rectangle', 'rectangle'],
  approvedFills: ['#dbeafe', '#bfdbfe'],
  approvedStrokes: ['#1e3a8a'],
  ...over,
});

describe('addElementOfKind', () => {
  it('adds a node with role, default shape and default fill/stroke, and returns its id', () => {
    const { model, nodeId } = addElementOfKind(empty(), kind());
    const node = model.nodes.find((n) => n.id === nodeId)!;
    expect(node.role).toBe('primary_activity');
    expect(node.shape).toBe('rounded-rectangle');
    expect(node.style?.fillColor).toBe('#dbeafe');
    expect(node.style?.strokeColor).toBe('#1e3a8a');
  });

  it('sets external from match', () => {
    const { model, nodeId } = addElementOfKind(
      { ...empty(), diagramTypeId: 'c4-context' },
      kind({ id: 'ext_system', shapes: ['rectangle'], match: { role: 'system', external: true } }),
    );
    const node = model.nodes.find((n) => n.id === nodeId)!;
    expect(node.role).toBe('system');
    expect(node.external).toBe(true);
  });

  it('uses the label option', () => {
    const { model, nodeId } = addElementOfKind(empty(), kind(), { label: 'Inbound Logistics' });
    expect(model.nodes.find((n) => n.id === nodeId)!.label).toBe('Inbound Logistics');
  });

  it('does not mutate the input model', () => {
    const input = empty();
    const snapshot = JSON.stringify(input);
    addElementOfKind(input, kind());
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.nodes).toHaveLength(0);
  });
});

describe('applyElementKind', () => {
  const withNode = (over: Record<string, unknown>): DiagramModel => ({
    ...empty(),
    nodes: [{ id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, ...over }],
  });

  it('sets role and keeps an allowed shape and an approved fill (case-insensitive)', () => {
    const out = applyElementKind(withNode({ shape: 'rectangle', style: { fillColor: '#BFDBFE' } }), 'A', kind());
    const n = out.nodes[0];
    expect(n.role).toBe('primary_activity');
    expect(n.shape).toBe('rectangle');
    expect(n.style?.fillColor).toBe('#BFDBFE');
  });

  it('switches to the default shape and fill when the current ones are not allowed', () => {
    const out = applyElementKind(withNode({ shape: 'circle', style: { fillColor: '#ff0000' } }), 'A', kind());
    const n = out.nodes[0];
    expect(n.shape).toBe('rounded-rectangle');
    expect(n.style?.fillColor).toBe('#dbeafe');
  });

  it('keeps any shape when the kind has no shape list', () => {
    const out = applyElementKind(withNode({ shape: 'hexagon' }), 'A', kind({ shapes: [] }));
    expect(out.nodes[0].shape).toBe('hexagon');
  });

  it('sets external from match', () => {
    const out = applyElementKind(withNode({ role: 'system' }), 'A', kind({ shapes: [], match: { role: 'system', external: true } }));
    expect(out.nodes[0].external).toBe(true);
  });

  it('returns the model unchanged for an unknown node id', () => {
    const input = withNode({});
    expect(applyElementKind(input, 'nope', kind())).toEqual(input);
  });

  it('does not mutate its input', () => {
    const input = withNode({});
    const snapshot = JSON.stringify(input);
    applyElementKind(input, 'A', kind());
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('applyConnectorRule', () => {
  const rule: ConnectorRule = {
    id: 'feeds', label: 'Feeds', from: '*', to: '*',
    lineStyles: ['dotted', 'solid'], arrows: ['both', 'target'], approvedStrokes: ['#123456'],
  };
  const m: DiagramModel = {
    ...empty(),
    nodes: [
      { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'B', label: 'B', shape: 'rectangle', position: { x: 0, y: 0 } },
    ],
    edges: [{ id: 'e1', sourceId: 'A', targetId: 'B' }],
  };

  it('applies first arrow, line style and stroke', () => {
    const e = applyConnectorRule(m, 'e1', rule).edges[0];
    expect(e.arrow).toBe('both');
    expect(e.lineStyle).toBe('dotted');
    expect(e.style?.strokeColor).toBe('#123456');
  });

  it('returns the model unchanged for an unknown edge id', () => {
    expect(applyConnectorRule(m, 'nope', rule)).toEqual(m);
  });
});
