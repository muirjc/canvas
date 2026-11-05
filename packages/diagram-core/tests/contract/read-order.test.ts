import { describe, expect, it } from 'vitest';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { inReadOrder } from '../../src/dsl/read-order.js';
import { isParseSuccess, type ParseResult } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

const node = (id: string, extra: object = {}) => ({ id, label: id, shape: 'rectangle', ...extra });
const ids = (items: { id: string }[]) => items.map((i) => i.id);

function modelOf(nodes: string[], containers: string[] = []): DiagramModel {
  return {
    diagramTypeId: 'flowchart',
    nodes: nodes.map((id) => node(id)),
    edges: [{ id: 'e1', sourceId: nodes[0], targetId: nodes[1] }],
    containers: containers.map((id) => ({ id, label: id })),
    standardVersionId: 'sv-1',
  } as unknown as DiagramModel;
}

/** A parse that "reads back" the given ids, whatever the text. */
function readsBack(nodeIds: string[], containerIds: string[] = []): (dsl: string) => ParseResult {
  const model = {
    ...modelOf(['x', 'y']),
    nodes: nodeIds.map((id) => node(id)),
    containers: containerIds.map((id) => ({ id, label: id })),
  } as unknown as DiagramModel;
  return () => ({ model });
}

describe('inReadOrder', () => {
  const write = () => 'text';

  it('sorts nodes and containers into the order the parsed model has them', () => {
    const m = modelOf(['a', 'b', 'c'], ['g1', 'g2']);
    const out = inReadOrder(m, readsBack(['c', 'a', 'b'], ['g2', 'g1']), write);
    expect(ids(out.nodes)).toEqual(['c', 'a', 'b']);
    expect(ids(out.containers)).toEqual(['g2', 'g1']);
  });

  it('uses the first place an id comes in the parsed model', () => {
    const m = modelOf(['a', 'b', 'c']);
    const out = inReadOrder(m, readsBack(['b', 'c', 'b', 'a']), write);
    expect(ids(out.nodes)).toEqual(['b', 'c', 'a']);
  });

  it('puts items the parsed model lacks last, in their own order', () => {
    const m = modelOf(['a', 'x1', 'b', 'x2']);
    const out = inReadOrder(m, readsBack(['b', 'a']), write);
    expect(ids(out.nodes)).toEqual(['b', 'a', 'x1', 'x2']);
  });

  it('keeps the original order of items that share an id', () => {
    const m = modelOf(['a', 'b']);
    m.nodes = [
      node('a', { label: 'first' }),
      node('b'),
      node('a', { label: 'second' }),
    ] as DiagramModel['nodes'];
    const out = inReadOrder(m, readsBack(['b', 'a']), write);
    expect(out.nodes.map((n) => n.label)).toEqual(['b', 'first', 'second']);
  });

  it('returns the very same model when the text does not read back', () => {
    const m = modelOf(['a', 'b']);
    const out = inReadOrder(
      m,
      () => ({ errors: [{ line: 1, content: '', message: 'bad' }] }),
      write,
    );
    expect(out).toBe(m);
  });

  it('leaves edges and every other field alone, and writes the original model', () => {
    const m = modelOf(['a', 'b']);
    const written: DiagramModel[] = [];
    const out = inReadOrder(m, readsBack(['b', 'a']), (x) => (written.push(x), 'text'));
    expect(written).toEqual([m]);
    expect(written[0]).toBe(m);
    expect(out.edges).toBe(m.edges);
    expect(out.standardVersionId).toBe('sv-1');
    expect(out.diagramTypeId).toBe('flowchart');
    expect(m.nodes.map((n) => n.id)).toEqual(['a', 'b']); // input not mutated
  });
});

describe('inReadOrder with a real serializer', () => {
  const DSL = `C4Container
    Person(u, "User")
    System_Boundary(b, "Shop") {
      Container(web, "Web")
      Container(api, "API")
    }
    ContainerDb(db, "DB")
    Rel(u, web, "uses")
    Rel(web, api, "calls")
    Rel(api, db, "reads")
`;

  it('a model in a different order from its grouped text saves the same text twice', () => {
    const parsed = parseC4(DSL);
    if (!isParseSuccess(parsed)) throw new Error('fixture must parse');
    // Declared the way an editor might add them: the lone shape first, members after.
    const m: DiagramModel = {
      ...parsed.model,
      nodes: [...parsed.model.nodes].reverse(),
      containers: [...parsed.model.containers].reverse(),
    };
    const first = serializeC4(m);
    const reparsed = parseC4(first);
    if (!isParseSuccess(reparsed)) throw new Error('first save must parse');
    expect(serializeC4(reparsed.model)).toBe(first);
  });
});
