import { describe, expect, it } from 'vitest';
import { findElementLine, getDslFamily } from '../../src/index.js';

/** canvas-3s5.3: the line an element is declared on, shared by the editor's Issues list and the CI
 *  validator's GitHub annotations (moved here from apps/web). */
function model(family: string, dsl: string) {
  const result = getDslFamily(family)!.parse(dsl);
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.model;
}

describe('findElementLine', () => {
  const flowchart = 'flowchart TD\n  a[Alpha] --> b[Beta]\n  c{Gamma}\n  subgraph grp [Group]\n    d\n  end\n';

  it('finds a node declared with a shape, alone, or inline on an edge line', () => {
    const m = model('flowchart', flowchart);
    expect(findElementLine(flowchart, 'c', m)).toBe(3);
    expect(findElementLine(flowchart, 'a', m)).toBe(2);
    expect(findElementLine(flowchart, 'd', m)).toBe(5);
  });

  it('finds a subgraph by its id', () => {
    expect(findElementLine(flowchart, 'grp', model('flowchart', flowchart))).toBe(4);
  });

  it('finds an edge by the line mentioning both endpoints', () => {
    const m = model('flowchart', flowchart);
    expect(findElementLine(flowchart, m.edges[0].id, m)).toBe(2);
  });

  it('finds a C4 element by its macro', () => {
    const dsl = 'C4Context\n  Person(user, "User")\n  System(sys, "System")\n  Rel(user, sys, "Uses")\n';
    const m = model('c4', dsl);
    expect(findElementLine(dsl, 'sys', m)).toBe(3);
    expect(findElementLine(dsl, m.edges[0].id, m)).toBe(4);
  });

  it('is undefined when nothing plausible matches, never a wrong line', () => {
    expect(findElementLine(flowchart, 'nope', model('flowchart', flowchart))).toBeUndefined();
  });
});

describe('findElementLine: a node declared inline on the right-hand side of an edge', () => {
  const dsl = 'flowchart TD\n  a[Alpha]:::step --> b[Beta]:::mystery\n  b --> c(Gamma) & d{Delta}\n';
  const m = model('flowchart', dsl);

  it('finds the target of an edge, not only its source', () => {
    expect(findElementLine(dsl, 'b', m)).toBe(2);
  });

  it('finds fan-out targets after an ampersand', () => {
    expect(findElementLine(dsl, 'c', m)).toBe(3);
    expect(findElementLine(dsl, 'd', m)).toBe(3);
  });

  it('still prefers a declaration at the start of a line', () => {
    const text = 'flowchart TD\n  x --> y[Late]\n  y[Early]\n';
    expect(findElementLine(text, 'y', model('flowchart', text))).toBe(3);
  });

  it('does not treat a bare reference as a declaration', () => {
    const text = 'flowchart TD\n  p[P] --> q\n';
    expect(findElementLine(text, 'q', model('flowchart', text))).toBeUndefined();
  });
});
