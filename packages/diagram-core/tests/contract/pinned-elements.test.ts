// canvas-rqm6: pinned shapes and groups -- saved in front matter (`canvas.pinned`) by every family but
// sequence, and left where they are by Auto Layout, which arranges everything else around them.
import { describe, expect, it } from 'vitest';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { autoLayout, pinnedElementIds } from '../../src/model/auto-layout.js';
import { setPinned } from '../../src/model/diagram-ops.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

function parse(family: string, dsl: string): DiagramModel {
  const result = getDslFamily(family)!.parse(dsl);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const serialize = (family: string, model: DiagramModel) => getDslFamily(family)!.serialize(model);

const BODIES: Record<string, string> = {
  flowchart: 'flowchart TD\n  a[A] --> b[B]\n',
  c4: 'C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "x")\n',
  erd: 'erDiagram\n  a ||--o{ b : has\n',
  uml: 'classDiagram\n  a <|-- b\n',
  architecture: 'architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  a:R -- L:b\n',
};

describe('pinned: saved and read back', () => {
  it.each(Object.keys(BODIES))('%s keeps its pins through a save', (family) => {
    const model = setPinned(parse(family, BODIES[family]), ['b'], true);
    const saved = serialize(family, model);
    expect(saved).toContain('pinned:');
    const again = parse(family, saved);
    expect(again.pinned).toEqual(['b']);
    expect(serialize(family, again)).toBe(saved);
  });

  it('drops ids the diagram no longer has, duplicates and non-strings', () => {
    const dsl = '---\ncanvas:\n  pinned: [b, ghost, b, 3, a]\n---\nflowchart TD\n  a[A] --> b[B]\n';
    const model = parse('flowchart', dsl);
    expect(model.pinned).toEqual(['b', 'a']);
    expect(serialize('flowchart', { ...model, nodes: model.nodes.filter((n) => n.id !== 'a') })).toContain('pinned:\n    - b\n');
  });

  it('a diagram with nothing pinned has no pinned field and no front matter for it', () => {
    const model = parse('flowchart', BODIES.flowchart);
    expect('pinned' in model).toBe(false);
    expect(serialize('flowchart', setPinned(setPinned(model, ['a'], true), ['a'], false))).not.toContain('pinned');
  });

  it('setPinned adds once, in order, and removes', () => {
    const model = parse('flowchart', 'flowchart TD\n  a --> b --> c\n');
    const pinned = setPinned(setPinned(model, ['c', 'a', 'c'], true), ['a', 'b'], true);
    expect(pinned.pinned).toEqual(['c', 'a', 'b']);
    expect(setPinned(pinned, ['a'], false).pinned).toEqual(['c', 'b']);
    expect('pinned' in setPinned(pinned, ['a', 'b', 'c'], false)).toBe(false);
    expect(model.pinned).toBeUndefined();
  });
});

describe('pinned: Auto Layout', () => {
  const chain = (): DiagramModel => parse('flowchart', 'flowchart TD\n  a[A] --> b[B] --> c[C] --> d[D]\n');
  const at = (model: DiagramModel, id: string) => model.nodes.find((n) => n.id === id)!.position;

  it('with nothing pinned, nothing changes from before', () => {
    const model = chain();
    expect(autoLayout({ ...model, pinned: [] }, 'TD').nodes).toEqual(autoLayout(model, 'TD').nodes);
    expect(autoLayout({ ...model, pinned: ['ghost'] }, 'TD').nodes).toEqual(autoLayout(model, 'TD').nodes);
  });

  it('one pin stays put and the rest is arranged around it, as it would be anyway', () => {
    const model = chain();
    const moved = { ...model, nodes: model.nodes.map((n) => (n.id === 'c' ? { ...n, position: { x: 900, y: 700 } } : n)) };
    const free = autoLayout(moved, 'TD');
    const pinned = autoLayout(setPinned(moved, ['c'], true), 'TD');
    expect(at(pinned, 'c')).toEqual({ x: 900, y: 700 });
    // Same arrangement, shifted so c is where it was.
    const dx = 900 - at(free, 'c').x;
    const dy = 700 - at(free, 'c').y;
    for (const id of ['a', 'b', 'd']) expect(at(pinned, id)).toEqual({ x: at(free, id).x + dx, y: at(free, id).y + dy });
    expect(pinned.pinned).toEqual(['c']);
  });

  it('several pins all stay exactly; the rest moves by their average shift', () => {
    const model = setPinned(chain(), ['a', 'd'], true);
    const free = autoLayout({ ...model, pinned: undefined }, 'LR');
    const laid = autoLayout(model, 'LR');
    expect(at(laid, 'a')).toEqual(at(model, 'a'));
    expect(at(laid, 'd')).toEqual(at(model, 'd'));
    const dx = Math.round((at(model, 'a').x - at(free, 'a').x + at(model, 'd').x - at(free, 'd').x) / 2);
    const dy = Math.round((at(model, 'a').y - at(free, 'a').y + at(model, 'd').y - at(free, 'd').y) / 2);
    expect(at(laid, 'b')).toEqual({ x: at(free, 'b').x + dx, y: at(free, 'b').y + dy });
  });

  it('a pinned group keeps its place, its size and everything inside it', () => {
    const model = parse(
      'flowchart',
      'flowchart TD\n  subgraph g[G]\n    subgraph h[H]\n      x\n    end\n    y\n  end\n  z --> x\n',
    );
    const pinned = setPinned(model, ['g'], true);
    const laid = autoLayout(pinned, 'LR');
    for (const id of ['g', 'h']) expect(laid.containers.find((c) => c.id === id)).toEqual(model.containers.find((c) => c.id === id));
    expect(at(laid, 'x')).toEqual(at(model, 'x'));
    expect(at(laid, 'y')).toEqual(at(model, 'y'));
  });

  it('works for architecture diagrams too', () => {
    const model = setPinned(parse('architecture', BODIES.architecture), ['a'], true);
    const moved = { ...model, nodes: model.nodes.map((n) => (n.id === 'a' ? { ...n, position: { x: 500, y: 300 } } : n)) };
    expect(at(autoLayout(moved, undefined, 'architecture'), 'a')).toEqual({ x: 500, y: 300 });
  });

  it('pinnedElementIds ignores ids the model lacks', () => {
    expect(pinnedElementIds({ ...chain(), pinned: ['ghost', 'b', 'b'] })).toEqual(['b']);
  });
});
