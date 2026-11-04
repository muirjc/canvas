// canvas-bnnh: Mermaid state diagrams (stateDiagram-v2, Mermaid 12.3 syntax). The golden corpus
// (corpus/cases/state-*) pins whole outputs; these pin the rules behind them.
import { describe, expect, it } from 'vitest';
import { detectDslFamily } from '../../src/dsl/detect.js';
import { parseState, serializeState } from '../../src/dsl/state.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { autoLayout } from '../../src/model/auto-layout.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';

function parse(dsl: string): DiagramModel {
  const result = parseState(dsl);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const node = (m: DiagramModel, id: string) => m.nodes.find((n) => n.id === id)!;
const container = (m: DiagramModel, id: string) => m.containers.find((c) => c.id === id)!;
const errors = (dsl: string) => {
  const result = parseState(dsl);
  return isParseSuccess(result) ? [] : result.errors.map((e) => e.message);
};

describe('state diagrams: detection and headers', () => {
  it.each(['stateDiagram-v2', 'stateDiagram', 'STATEDIAGRAM-V2'])('%s is a state diagram', (header) => {
    expect(detectDslFamily(`${header}\n  [*] --> A\n`)).toBe('state');
    expect(parse(`${header}\n  [*] --> A\n`).diagramTypeId).toBe('state');
  });
});

describe('state diagrams: [*] start and end', () => {
  it('is a start as a source and an end as a target, one of each per scope', () => {
    const m = parse('stateDiagram-v2\n  [*] --> A\n  [*] --> B\n  A --> [*]\n  state C {\n    [*] --> c\n    c --> [*]\n  }\n');
    expect(m.nodes.filter((n) => n.role === 'start').map((n) => [n.id, n.containerId])).toEqual([
      ['root_start', undefined],
      ['C_start', 'C'],
    ]);
    expect(m.nodes.filter((n) => n.role === 'end').map((n) => n.id)).toEqual(['root_end', 'C_end']);
    expect(node(m, 'root_start')).toMatchObject({ shape: 'state-start', label: '' });
    expect(node(m, 'root_end').shape).toBe('state-end');
  });

  it('each concurrent region has its own', () => {
    const m = parse('stateDiagram-v2\n  state Active {\n    [*] --> a\n    --\n    [*] --> b\n  }\n');
    expect(m.containers.map((c) => [c.id, c.role, c.parentContainerId])).toEqual([
      ['Active', 'composite', undefined],
      ['Active__region1', 'region', 'Active'],
      ['Active__region2', 'region', 'Active'],
    ]);
    expect(node(m, 'a').containerId).toBe('Active__region1');
    expect(node(m, 'Active__region2_start').containerId).toBe('Active__region2');
    expect(serializeState(m)).toContain('    [*] --> a\n    --\n    [*] --> b\n');
  });
});

describe('state diagrams: states', () => {
  it('names and descriptions', () => {
    const m = parse('stateDiagram-v2\n  state "Long name" as s1\n  s2 : first\n  s2 : second\n  state "Alias" as s3:desc\n  plain\n');
    expect(node(m, 's1')).toMatchObject({ label: 'Long name', role: 'state', shape: 'rounded-rectangle' });
    expect(node(m, 's2')).toMatchObject({ label: 's2', description: 'first\nsecond' });
    expect(node(m, 's3')).toMatchObject({ label: 'Alias', description: 'desc' });
    expect(node(m, 'plain').label).toBe('plain');
  });

  it('choice, fork and join, in both spellings', () => {
    const m = parse('stateDiagram-v2\n  state c <<choice>>\n  state f <<fork>>\n  state j [[join]]\n');
    expect(m.nodes.map((n) => [n.id, n.role, n.shape, n.label])).toEqual([
      ['c', 'choice', 'diamond', ''],
      ['f', 'fork', 'fork-bar', ''],
      ['j', 'join', 'fork-bar', ''],
    ]);
  });

  it('a state named before its block becomes the composite, keeping the name', () => {
    const m = parse('stateDiagram-v2\n  A --> B\n  B : Busy work\n  state B {\n    x --> y\n  }\n');
    expect(m.nodes.map((n) => n.id)).not.toContain('B');
    expect(container(m, 'B')).toMatchObject({ role: 'composite', label: 'Busy work' });
    expect(m.edges[0]).toMatchObject({ sourceId: 'A', targetId: 'B' });
  });

  it('composites nest, each with its own direction', () => {
    const m = parse('stateDiagram-v2\n  direction LR\n  state Outer {\n    direction TB\n    state Inner {\n      a --> b\n    }\n  }\n');
    expect(m.direction).toBe('LR');
    expect(container(m, 'Outer').direction).toBe('TB');
    expect(container(m, 'Inner').parentContainerId).toBe('Outer');
    expect(node(m, 'a').containerId).toBe('Inner');
  });
});

describe('state diagrams: notes, styles and links', () => {
  it('notes attach to their state, one line or a block', () => {
    const m = parse('stateDiagram-v2\n  note right of A : short\n  note left of B\n    two: lines\n    here\n  end note\n');
    expect(m.containers.map((c) => [c.id, c.role, c.label, c.attachedNodeIds])).toEqual([
      ['note1', 'note-right', 'short', ['A']],
      ['note2', 'note-left', 'two: lines\nhere', ['B']],
    ]);
    expect(serializeState(m)).toContain('  note left of B\n    two: lines\n    here\n  end note\n');
  });

  it('classes, ::: and style lines become each state\'s style; the front matter wins', () => {
    const dsl = 'stateDiagram-v2\n  classDef hot fill:#f00,stroke:#900\n  A:::hot --> B\n  class B hot\n  style B stroke:#00f\n';
    const m = parse(dsl);
    expect(node(m, 'A').style).toEqual({ fillColor: '#f00', strokeColor: '#900' });
    expect(node(m, 'B').style).toEqual({ fillColor: '#f00', strokeColor: '#00f' });
    const saved = parse(`---\ncanvas:\n  styles:\n    A: {fillColor: "#0f0"}\n---\n${dsl}`);
    expect(node(saved, 'A').style).toEqual({ fillColor: '#0f0' });
  });

  it('click links are checked like flowchart ones; call is refused', () => {
    expect(node(parse('stateDiagram-v2\n  A\n  click A href "https://x.org" "tip"\n'), 'A').link).toEqual({ href: 'https://x.org', tooltip: 'tip' });
    expect(errors('stateDiagram-v2\n  A\n  click A href "javascript:alert(1)"\n')[0]).toMatch(/not allowed/);
    expect(errors('stateDiagram-v2\n  A\n  click A call cb()\n')[0]).toMatch(/runs script/);
  });
});

describe('state diagrams: what is refused', () => {
  it.each([
    ['A -> B', /Could not interpret/],
    ['A --> B --> C', /Could not interpret/],
    ['--', /only belongs inside a composite/],
    ['}', /no open composite/],
  ])('%s', (line, message) => {
    expect(errors(`stateDiagram-v2\n  ${line}\n`)[0]).toMatch(message);
  });

  it('an unclosed block or note', () => {
    expect(errors('stateDiagram-v2\n  state X {\n')).toEqual(['Composite state "X" has no closing "}".']);
    expect(errors('stateDiagram-v2\n  note left of A\n  text\n')).toEqual(['Note has no "end note".']);
  });
});

describe('state diagrams: saving', () => {
  it('a connector keeps its id, and its colour, through a save', () => {
    const m = parse('stateDiagram-v2\n  [*] --> A\n  state A {\n    x --> y\n  }\n  A --> B\n');
    const styled = { ...m, edges: m.edges.map((e) => (e.sourceId === 'A' ? { ...e, style: { strokeColor: '#123456' } } : e)) };
    const again = parse(serializeState(styled));
    expect(again.edges.map((e) => [e.id, e.sourceId, e.targetId])).toEqual(m.edges.map((e) => [e.id, e.sourceId, e.targetId]));
    expect(again.edges.find((e) => e.sourceId === 'A')!.style).toEqual({ strokeColor: '#123456' });
  });

  it('the title lives in the front matter, as Mermaid reads it', () => {
    const m = parse('---\ntitle: Lifecycle\n---\nstateDiagram-v2\n  A --> B\n');
    expect(m.title).toBe('Lifecycle');
    expect(serializeState(m)).toMatch(/^---\ntitle: Lifecycle\n/);
  });
});

describe('state diagrams: drawing and Auto Layout', () => {
  const m = parse('stateDiagram-v2\n  [*] --> A\n  state c <<choice>>\n  A --> c\n  c --> Done\n  Done --> [*]\n  state Done {\n    x --> y\n  }\n');

  it('pseudo-states are small and unlabelled; a connector can end on a composite', () => {
    const svg = renderToSvg(autoLayout(m, 'LR', 'state'));
    expect(svg).toContain('data-node-id="root_start"');
    expect(svg).toContain('data-container-id="Done"');
    // c --> Done and Done --> [*] are drawn (to the composite's box).
    expect(svg.match(/marker-end="url\(#arrowhead\)"/g)!.length).toBe(m.edges.length);
  });

  it('Auto Layout arranges state diagrams and keeps their direction', () => {
    const laid = autoLayout(m, 'LR', 'state');
    expect(laid.direction).toBe('LR');
    expect(node(laid, 'A').position.x).toBeGreaterThan(node(laid, 'root_start').position.x);
  });
});

describe('state diagrams: built in the editor or by the AI (canvas-bnnh part 2)', () => {
  it('addStateNode gives each kind its role and shape; a scope has one start and one end', async () => {
    const { addStateNode, statePseudoId } = await import('../../src/model/diagram-ops.js');
    let m: DiagramModel = { diagramTypeId: 'state', nodes: [], edges: [], containers: [] };
    for (const kind of ['state', 'start', 'end', 'choice', 'fork', 'join', 'start'] as const) m = addStateNode(m, { kind });
    expect(m.nodes.map((n) => [n.role, n.shape, n.label])).toEqual([
      ['state', 'rounded-rectangle', 'New State'],
      ['start', 'state-start', ''],
      ['end', 'state-end', ''],
      ['choice', 'diamond', ''],
      ['fork', 'fork-bar', ''],
      ['join', 'fork-bar', ''],
    ]);
    expect(m.nodes[1].id).toBe(statePseudoId('start'));
    expect(addStateNode(m, { kind: 'start', containerId: 'G' }).nodes.at(-1)!.id).toBe('G_start');
  });

  it('a node with only a shape, a group with no role and a connector with no scope still save as Mermaid', () => {
    const model: DiagramModel = {
      diagramTypeId: 'state',
      nodes: [
        { id: 'go', label: '', shape: 'state-start', position: { x: 0, y: 0 }, containerId: 'G' },
        { id: 'a', label: 'a', shape: 'rounded-rectangle', position: { x: 0, y: 0 }, containerId: 'G' },
        { id: 'bar', label: '', shape: 'fork-bar', position: { x: 0, y: 0 } },
      ],
      containers: [{ id: 'G', label: 'Group', position: { x: 0, y: 0 } }],
      edges: [
        { id: 'x1', sourceId: 'go', targetId: 'a' },
        { id: 'x2', sourceId: 'G', targetId: 'bar' },
      ],
    };
    const text = serializeState(model);
    expect(text).toContain('  state "Group" as G {\n    [*] --> a\n  }\n');
    expect(text).toContain('  state bar <<fork>>\n');
    expect(text).toContain('  G --> bar\n');
    const again = parse(text);
    expect(container(again, 'G').role).toBe('composite');
    expect(node(again, 'G_start').containerId).toBe('G');
  });
});
