import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

// canvas-tfr: a flowchart node's element kind is carried as its Mermaid class (`A[x]:::kind`) and
// surfaces on the model as `node.role`.

function parse(dsl: string): DiagramModel {
  const result = parseFlowchart(dsl);
  if (!isParseSuccess(result)) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
  return result.model;
}

describe('flowchart kind: parsing', () => {
  it('sets role from a :::class on a bracketed node, with no classDef needed', () => {
    const node = parse('flowchart LR\n  A[Inbound]:::primary_activity\n').nodes.find((n) => n.id === 'A')!;
    expect(node.role).toBe('primary_activity');
    expect(node.label).toBe('Inbound');
  });

  it('sets role from a bare A:::k line', () => {
    const m = parse('flowchart LR\n  A[Start]\n  A:::k\n');
    expect(m.nodes.find((n) => n.id === 'A')!.role).toBe('k');
  });

  it('sets role on every node of a `class A,B k` line', () => {
    const m = parse('flowchart LR\n  A[One]\n  B[Two]\n  class A,B k\n');
    expect(m.nodes.map((n) => n.role)).toEqual(['k', 'k']);
  });

  it('the first class wins when several are given', () => {
    const m = parse('flowchart LR\n  A[One]\n  A:::k1,k2\n');
    expect(m.nodes.find((n) => n.id === 'A')!.role).toBe('k1');
  });

  it('an existing classDef + class file gets role and keeps the fill', () => {
    const m = parse('flowchart LR\n  A[One]\n  classDef hot fill:#f00\n  class A hot\n');
    const a = m.nodes.find((n) => n.id === 'A')!;
    expect(a.role).toBe('hot');
    expect(a.style?.fillColor).toBe('#f00');
  });
});

describe('flowchart kind: serializing', () => {
  const base = (role: string | undefined, extra: Partial<DiagramModel['nodes'][number]> = {}): DiagramModel => ({
    diagramTypeId: 'flowchart',
    nodes: [{ id: 'A', label: 'Inbound', shape: 'rectangle', role, position: { x: 0, y: 0 }, ...extra }],
    edges: [],
    containers: [],
  });

  it('emits :::role on the node line', () => {
    const dsl = serializeFlowchart(base('primary_activity'));
    expect(dsl).toMatch(/^\s*A\[Inbound\]:::primary_activity\s*$/m);
  });

  it('emits :::role for a node inside a subgraph', () => {
    const m: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: 'Inbound', shape: 'rectangle', role: 'primary_activity', position: { x: 0, y: 0 }, containerId: 'g' }],
      edges: [],
      containers: [{ id: 'g', label: 'Group', position: { x: 0, y: 0 } }],
    };
    const dsl = serializeFlowchart(m);
    expect(dsl).toMatch(/subgraph g/);
    expect(dsl).toMatch(/^\s*A\[Inbound\]:::primary_activity\s*$/m);
  });

  it('parse -> serialize -> parse is stable for role, shape and label', () => {
    const first = parse('flowchart LR\n  A[Inbound]:::primary_activity\n  B(Ops):::support_activity\n  A --> B\n');
    const second = parse(serializeFlowchart(first));
    const pick = (m: DiagramModel) => m.nodes.map((n) => ({ id: n.id, role: n.role, shape: n.shape, label: n.label }));
    expect(pick(second)).toEqual(pick(first));
    expect(pick(second).map((n) => n.role)).toEqual(['primary_activity', 'support_activity']);
  });

  it('keeps a per-node front-matter fill alongside the role, and never emits a classDef', () => {
    const dsl = serializeFlowchart(base('k', { style: { fillColor: '#fef3c7' } }));
    expect(dsl).not.toMatch(/classDef/);
    const a = parse(dsl).nodes.find((n) => n.id === 'A')!;
    expect(a.role).toBe('k');
    expect(a.style?.fillColor).toBe('#fef3c7');
  });

  it.each(['has-dash', 'has space'])('skips a role that is not a valid ID token (%j) and still parses', (role) => {
    const dsl = serializeFlowchart(base(role));
    expect(dsl).not.toContain(':::');
    expect(isParseSuccess(parseFlowchart(dsl))).toBe(true);
  });
});
