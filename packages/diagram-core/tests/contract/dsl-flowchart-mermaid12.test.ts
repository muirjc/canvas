import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { mermaidShapeToCanvas } from '../../src/dsl/mermaid-shape-data.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

// canvas-8wxq part 2: Mermaid 11.3+/12 flowchart syntax -- `A@{ shape: …, label: … }` and edge ids.
function parse(body: string): DiagramModel {
  const result = parseFlowchart(`flowchart TD\n${body}\n`);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
function errors(body: string): string[] {
  const result = parseFlowchart(`flowchart TD\n${body}\n`);
  if (isParseSuccess(result)) throw new Error('expected a parse error');
  return result.errors.map((e) => e.message);
}
const node = (m: DiagramModel, id: string) => m.nodes.find((n) => n.id === id)!;

describe('node shape data', () => {
  it('reads shape, label and extra keys on a line of its own', () => {
    const n = node(parse('A@{ shape: cyl, label: "Orders", w: 3, ok: true, note: hi there }'), 'A');
    expect(n.mermaidShape).toBe('cyl');
    expect(n.shape).toBe('cylinder');
    expect(n.label).toBe('Orders');
    expect(n.mermaidData).toEqual({ w: 3, ok: true, note: 'hi there' });
    expect(Object.keys(n.mermaidData!)).toEqual(['w', 'ok', 'note']);
  });

  it('reads it at an edge end, with fan-out and a class before the block', () => {
    const m = parse('A@{ shape: circle } --> B & C@{ shape: hex }\nD:::kind@{ shape: diam }');
    expect(node(m, 'A').shape).toBe('circle');
    expect(node(m, 'C').shape).toBe('hexagon');
    expect(m.edges.map((e) => [e.sourceId, e.targetId])).toEqual([['A', 'B'], ['A', 'C']]);
    expect(node(m, 'D').shape).toBe('diamond');
    expect(node(m, 'D').role).toBe('kind');
  });

  it('applies over an existing node', () => {
    const n = node(parse('A[Plain]\nA@{ shape: stadium, label: "Fancy" }'), 'A');
    expect([n.shape, n.label]).toEqual(['stadium', 'Fancy']);
  });

  it('reads single-quoted and escaped values', () => {
    const n = node(parse(`A@{ label: 'it''s', a: "q\\"b\\\\c\\nd" }`), 'A');
    expect(n.label).toBe("it's");
    expect(n.mermaidData!.a).toBe('q"b\\c\nd');
  });

  it.each([
    ['cyl', 'cylinder'], ['db', 'cylinder'], ['database', 'cylinder'], ['diam', 'diamond'], ['decision', 'diamond'],
    ['fr-rect', 'subroutine'], ['subprocess', 'subroutine'], ['lean-r', 'parallelogram'], ['lean-l', 'parallelogram-alt'],
    ['trap-b', 'trapezoid'], ['trap-t', 'trapezoid-alt'], ['odd', 'asymmetric'], ['fork', 'fork-bar'], ['join', 'fork-bar'],
    ['doc', 'rectangle'], ['cloud', 'rectangle'], ['made-up-name', 'rectangle'],
  ])('shape %s draws as %s and keeps its name', (name, shape) => {
    const n = node(parse(`A@{ shape: ${name} }`), 'A');
    expect(n.shape).toBe(shape);
    expect(n.mermaidShape).toBe(name);
  });

  it('maps a rectangle with an icon to the icon shape', () => {
    expect(mermaidShapeToCanvas('rect', true)).toBe('icon');
    expect(mermaidShapeToCanvas('cyl', true)).toBe('cylinder');
  });

  it('refuses a malformed block', () => {
    for (const body of [
      'A@{ shape cyl }', 'A@{ shape: }', 'A@{ shape: cyl, shape: hex }', 'A@{ shape: "not a name" }',
      'A@{ shape: cyl } junk', 'A@{ img: "javascript:alert(1)", shape: rect }',
    ]) {
      expect(errors(body).length, body).toBeGreaterThan(0);
    }
  });
});

describe('edge ids', () => {
  it('reads an id on every edge form', () => {
    const m = parse(
      'A e1@--> B\nA e2@-->|x| C\nA e3@-- text --> D\nA e4@-.-> E\nA e5@==> F\nG e6@--> H e7@--> I',
    );
    expect(m.edges.map((e) => e.mermaidId)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
    expect(m.edges[1].label).toBe('x');
    expect(m.edges[2].label).toBe('text');
    expect(m.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  });

  it('keeps Canvas ids positional', () => {
    const m = parse('A x@--> B\nB y@--> C');
    expect(m.edges.map((e) => [e.id, e.mermaidId])).toEqual([['e1', 'x'], ['e2', 'y']]);
  });

  it('refuses an id on a fan-out and a repeated id', () => {
    expect(errors('A e1@--> B & C').length).toBeGreaterThan(0);
    expect(errors('A e1@--> B\nB e1@--> C').join()).toMatch(/used twice/);
  });

  it('reads edge data from a later line, merged, and makes a node when no edge has the id yet', () => {
    const m = parse('A e1@--> B\ne1@{ animate: true }\ne1@{ curve: linear }\nz@{ animate: true }');
    expect(m.edges[0].mermaidData).toEqual({ animate: true, curve: 'linear' });
    expect(m.nodes.map((n) => n.id)).toContain('z');
    const early = parse('e1@{ animate: true }\nA e1@--> B');
    expect(early.nodes.map((n) => n.id)).toContain('e1');
  });

  it('refuses subgraph view data', () => {
    expect(errors('subgraph one\nA\nend\none@{ view: collapsed }').join()).toMatch(/not read yet/);
  });
});

describe('serializing', () => {
  const dsl = [
    'flowchart TD',
    '  A:::kind@{ shape: cyl, label: "Orders", w: 3, ok: false }',
    '  B[Plain]',
    '  C@{ shape: doc }',
    '  A e1@-->|x| B',
    '  B --> C',
    '  e1@{ animate: true, curve: "linear" }',
    '',
  ].join('\n');

  it('writes shape data, edge ids and edge data', () => {
    const out = serializeFlowchart(parse(dsl.split('\n').slice(1).join('\n')));
    expect(out).toContain('  A:::kind@{ shape: cyl, label: "Orders", w: 3, ok: false }');
    expect(out).toContain('  C@{ shape: doc }');
    expect(out).toContain('  A e1@-->|x| B');
    expect(out).toContain('  e1@{ animate: true, curve: "linear" }');
  });

  it('round-trips stably and keeps the fields', () => {
    const first = serializeFlowchart(parse(dsl.split('\n').slice(1).join('\n')));
    const result = parseFlowchart(first);
    if (!isParseSuccess(result)) throw new Error('reparse failed');
    expect(serializeFlowchart(result.model)).toBe(first);
    const a = node(result.model, 'A');
    expect([a.mermaidShape, a.shape, a.label, a.mermaidData]).toEqual(['cyl', 'cylinder', 'Orders', { w: 3, ok: false }]);
    expect(result.model.edges[0].mermaidId).toBe('e1');
    expect(result.model.edges[0].mermaidData).toEqual({ animate: true, curve: 'linear' });
  });

  it('leaves the label out when it equals the id', () => {
    expect(serializeFlowchart(parse('A@{ shape: cyl }'))).toContain('  A@{ shape: cyl }');
    expect(serializeFlowchart(parse('A@{ shape: cyl, label: "A" }'))).toContain('  A@{ shape: cyl }');
  });

  it('writes the new shape name after the shape is changed in the model', () => {
    const m = parse('A@{ shape: db, label: "Orders" }');
    node(m, 'A').shape = 'hexagon';
    expect(serializeFlowchart(m)).toContain('A@{ shape: hex, label: "Orders" }');
    const kept = parse('A@{ shape: database }');
    expect(serializeFlowchart(kept)).toContain('A@{ shape: database }');
  });

  it('writes a plain rectangle with only data keys without a shape key', () => {
    expect(serializeFlowchart(parse('A[Box]\nA@{ w: 2 }'))).toMatch(/A@\{ label: "Box", w: 2 \}/);
  });

  it('drops invalid and duplicate edge ids, and an unsafe img', () => {
    const m = parse('A --> B\nB --> C\nC --> D');
    m.edges[0].mermaidId = 'good';
    m.edges[1].mermaidId = 'good';
    m.edges[2].mermaidId = 'bad id!';
    node(m, 'A').mermaidData = { img: 'javascript:alert(1)', w: 1 };
    const out = serializeFlowchart(m);
    expect(out.match(/good@/g)).toHaveLength(1);
    expect(out).not.toContain('bad id');
    expect(out).not.toContain('javascript');
  });

  it('escapes quotes, backslashes and newlines in labels', () => {
    const m = parse('A@{ shape: rect }');
    node(m, 'A').label = 'say "hi"\\\nbye';
    const out = serializeFlowchart(m);
    expect(out).toContain('label: "say \\"hi\\"\\\\\\nbye"');
    const again = parseFlowchart(out);
    if (!isParseSuccess(again)) throw new Error('reparse failed');
    expect(node(again.model, 'A').label).toBe('say "hi"\\\nbye');
  });

  it('leaves the bracket syntax unchanged for nodes without the new fields', () => {
    const src = 'flowchart TD\n  A[Start]\n  B{Ok?}\n  C[(Db)]\n  A --> B\n  B -->|yes| C\n';
    const result = parseFlowchart(src);
    if (!isParseSuccess(result)) throw new Error('parse failed');
    const out = serializeFlowchart(result.model);
    expect(out).toContain('A[Start]');
    expect(out).toContain('B{Ok?}');
    expect(out).toContain('C[(Db)]');
    expect(out).toContain('B -->|yes| C');
    expect(out).not.toContain('@');
  });
});

describe('rendering', () => {
  it('draws doc and cloud nodes as rectangles', () => {
    const svg = renderToSvg(parse('A@{ shape: doc }\nB@{ shape: cloud }\nA --> B'));
    expect(svg).toContain('<rect');
  });
});
