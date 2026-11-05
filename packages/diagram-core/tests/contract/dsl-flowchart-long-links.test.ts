import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { MAX_LINK_LENGTH } from '../../src/dsl/mermaid-shape-data.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

// canvas-sfz7: Mermaid's LINK rule at any length (`--->`, `====>`, `-..->`, `~~~~`), in every edge form.
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
const only = (m: DiagramModel) => {
  expect(m.edges).toHaveLength(1);
  return m.edges[0];
};
const reparse = (m: DiagramModel): DiagramModel => {
  const result = parseFlowchart(serializeFlowchart(m));
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
};

type Row = [token: string, lineStyle: string | undefined, arrow: string | undefined, length: number | undefined];
const TOKENS: Row[] = [
  ['-->', undefined, undefined, undefined], ['--->', undefined, undefined, 2], ['---->', undefined, undefined, 3],
  ['---', undefined, 'none', undefined], ['----', undefined, 'none', 2],
  ['==>', 'thick', undefined, undefined], ['===>', 'thick', undefined, 2],
  ['===', 'thick', 'none', undefined], ['====', 'thick', 'none', 2],
  ['-.->', 'dotted', undefined, undefined], ['-..->', 'dotted', undefined, 2],
  ['-.-', 'dotted', 'none', undefined], ['-..-', 'dotted', 'none', 2],
  ['<-->', undefined, 'both', undefined], ['<--->', undefined, 'both', 2],
  ['<==>', 'thick', 'both', undefined], ['<===>', 'thick', 'both', 2],
  ['<-.->', 'dotted', 'both', undefined], ['<-..->', 'dotted', 'both', 2],
  ['~~~', 'invisible', 'none', undefined], ['~~~~', 'invisible', 'none', 2],
];

describe('link tokens of any length', () => {
  it.each(TOKENS)('%s -> lineStyle %s, arrow %s, length %s', (token, lineStyle, arrow, length) => {
    const e = only(parse(`A ${token} B`));
    expect([e.sourceId, e.targetId]).toEqual(['A', 'B']);
    expect(e.lineStyle).toBe(lineStyle);
    expect(e.arrow).toBe(arrow);
    expect(e.mermaidLength).toBe(length);
    expect('mermaidLength' in e).toBe(length !== undefined);
    expect(e.label).toBeUndefined();
  });

  it.each(TOKENS)('%s round-trips and is written back at its length', (token) => {
    const m = parse(`A ${token} B`);
    const text = serializeFlowchart(m);
    expect(text).toContain(`A ${token} B`);
    expect(reparse(m).edges).toEqual(m.edges);
  });

  it('reads a long link with a pipe label', () => {
    const e = only(parse('A --->|x| B'));
    expect([e.label, e.mermaidLength]).toEqual(['x', 2]);
    const m = parse('A -..->|y| B');
    expect(reparse(m).edges).toEqual(m.edges);
  });

  it('reads a long link in an edge id', () => {
    const e = only(parse('A e1@---> B'));
    expect([e.mermaidId, e.mermaidLength]).toEqual(['e1', 2]);
    const m = parse('A e1@---> B');
    expect(reparse(m).edges).toEqual(m.edges);
  });

  it('reads a long link in fan-out', () => {
    const m = parse('A ---> B & C');
    expect(m.edges.map((e) => [e.sourceId, e.targetId, e.mermaidLength])).toEqual([['A', 'B', 2], ['A', 'C', 2]]);
    expect(reparse(m).edges).toEqual(m.edges);
  });

  it('reads E --> F ---> G as two edges (it was one edge E->G labelled "> F -")', () => {
    const m = parse('E --> F ---> G');
    expect(m.edges.map((e) => [e.sourceId, e.targetId, e.label, e.mermaidLength])).toEqual([
      ['E', 'F', undefined, undefined],
      ['F', 'G', undefined, 2],
    ]);
    expect(reparse(m).edges).toEqual(m.edges);
  });

  it('mixes lengths and styles in a chain', () => {
    const m = parse('A ----> B ===> C -..-> D');
    expect(m.edges.map((e) => [e.lineStyle, e.mermaidLength])).toEqual([[undefined, 3], ['thick', 2], ['dotted', 2]]);
    expect(reparse(m).edges).toEqual(m.edges);
  });

  it('reads a link longer than the cap at the cap', () => {
    const e = only(parse(`A ${'-'.repeat(1001)}> B`));
    expect(e.mermaidLength).toBe(MAX_LINK_LENGTH);
    expect(MAX_LINK_LENGTH).toBe(1000);
  });
});

describe('inline labels with long or arrowless closes', () => {
  it.each([
    ['A -- t ---> B', undefined, undefined, 2],
    ['A -- t --> B', undefined, undefined, undefined],
    ['A -- t --- B', undefined, 'none', undefined],
    ['A -. t ..-> B', 'dotted', undefined, 2],
    ['A -. t .-> B', 'dotted', undefined, undefined],
    ['A -. t .- B', 'dotted', 'none', undefined],
    ['A == t ===> B', 'thick', undefined, 2],
    ['A == t === B', 'thick', 'none', undefined],
    ['A -- x-y --> B', undefined, undefined, undefined],
  ])('%s', (line, lineStyle, arrow, length) => {
    const m = parse(line);
    const e = only(m);
    expect(e.label).toBe(line.includes('x-y') ? 'x-y' : 't');
    expect([e.sourceId, e.targetId]).toEqual(['A', 'B']);
    expect(e.lineStyle).toBe(lineStyle);
    expect(e.arrow).toBe(arrow);
    expect(e.mermaidLength).toBe(length);
    // written as a pipe label, and read back the same
    expect(serializeFlowchart(m)).toContain(`|${e.label}|`);
    expect(reparse(m).edges).toEqual(m.edges);
  });
});

describe('guards', () => {
  it.each(['A -- a --> B --> C', 'D --> b c --> E', 'A ==> x y ==> B'])('refuses %s', (line) => {
    expect(errors(line).length).toBeGreaterThan(0);
  });

  it.each(['A -- B', 'A <-- B', 'A => B', 'A -. B'])('still refuses the near miss %s', (line) => {
    expect(errors(line).length).toBeGreaterThan(0);
  });
});

describe('serializing an invalid mermaidLength', () => {
  const base = (): DiagramModel => parse('A --> B');
  const written = (value: unknown, extra: Record<string, unknown> = {}) => {
    const m = base();
    Object.assign(m.edges[0], { mermaidLength: value, ...extra });
    return serializeFlowchart(m);
  };

  it.each([[0], [-3], [1.5], [NaN], [1001], ['3'], [true]])('%s is written as length 1', (value) => {
    expect(written(value)).toContain('A --> B');
    expect(written(value)).not.toContain('--->');
  });

  it('writes length 1000 as is, and the same invalid value as 1 for other styles', () => {
    expect(written(1000)).toContain(`A ${'-'.repeat(1001)}> B`);
    expect(written('2', { lineStyle: 'dotted' })).toContain('A -.-> B');
    expect(written(0, { lineStyle: 'dotted', arrow: 'none' })).toContain('A -.- B');
    expect(written(2.5, { lineStyle: 'thick' })).toContain('A ==> B');
    expect(written(-1, { lineStyle: 'invisible' })).toContain('A ~~~ B');
  });

  it('writes valid lengths for dotted links as that many dots', () => {
    expect(written(3, { lineStyle: 'dotted' })).toContain('A -...-> B');
    expect(written(3, { lineStyle: 'dotted', arrow: 'none' })).toContain('A -...- B');
  });
});
