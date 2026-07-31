import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * Grouping B (docs/flowchart-completeness-brief.md): the additional Mermaid flowchart edge/link
 * syntax beyond plain `-->` — dotted, thick, no-arrowhead, bidirectional, invisible, chained edges
 * on one line, and fan-out via `&`. Distinct from `linkStyle` (already supported): these are new
 * *declaration* syntax, not a color/width override layered on top of an existing edge.
 */
describe('flowchart parser: additional edge/link syntax', () => {
  // `undefined` for lineStyle/arrow means "the default" (solid / a plain forward arrowhead) —
  // deliberately left unset rather than filled in explicitly, so a plain `A --> B` continues to
  // round-trip identically to how it always has (existing fixtures elsewhere construct edges with
  // no arrow/lineStyle field at all and expect exact round-trip equality).
  it.each([
    ['A --- B', undefined, 'none'],
    ['A --> B', undefined, undefined],
    ['A <--> B', undefined, 'both'],
    ['A -.- B', 'dotted', 'none'],
    ['A -.-> B', 'dotted', undefined],
    ['A <-.-> B', 'dotted', 'both'],
    ['A === B', 'thick', 'none'],
    ['A ==> B', 'thick', undefined],
    ['A <==> B', 'thick', 'both'],
    ['A ~~~ B', 'invisible', 'none'],
  ] as const)('parses "%s" as lineStyle=%s arrow=%s', (line, lineStyle, arrow) => {
    const result = parseFlowchart(`flowchart TD\n  ${line}\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.lineStyle).toBe(lineStyle);
      expect(edge.arrow).toBe(arrow);
      expect(edge.sourceId).toBe('A');
      expect(edge.targetId).toBe('B');
    }
  });

  it('does not misread a dotted connector (-.->)  as plain solid (-->), or vice versa', () => {
    const dotted = parseFlowchart('flowchart TD\n  A -.-> B\n');
    const solid = parseFlowchart('flowchart TD\n  A --> B\n');
    expect(isParseSuccess(dotted) && dotted.model.edges[0].lineStyle).toBe('dotted');
    expect(isParseSuccess(solid) && solid.model.edges[0].lineStyle).toBeUndefined();
  });

  it('does not misread a thick connector (==>) as a dotted or solid one', () => {
    const result = parseFlowchart('flowchart TD\n  A ==> B\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges[0].lineStyle).toBe('thick');
      expect(result.model.edges[0].arrow).toBeUndefined();
    }
  });

  it.each([
    ['A -->|label| B', undefined, undefined],
    ['A -.->|label| B', 'dotted', undefined],
    ['A ==>|label| B', 'thick', undefined],
    ['A <-->|label| B', undefined, 'both'],
    ['A ---|label| B', undefined, 'none'],
  ] as const)('applies a pipe label to any connector type: "%s"', (line, lineStyle, arrow) => {
    const result = parseFlowchart(`flowchart TD\n  ${line}\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.label).toBe('label');
      expect(edge.lineStyle).toBe(lineStyle);
      expect(edge.arrow).toBe(arrow);
    }
  });

  it.each([
    ['A -- label --> B', undefined],
    ['A -. label .-> B', 'dotted'],
    ['A == label ==> B', 'thick'],
  ] as const)('applies an inline (embedded) label to any connector type: "%s"', (line, lineStyle) => {
    const result = parseFlowchart(`flowchart TD\n  ${line}\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.label).toBe('label');
      expect(edge.lineStyle).toBe(lineStyle);
      expect(edge.arrow).toBeUndefined();
    }
  });

  it('splits a chained edge line (A --> B --> C) into two separate edges', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B --> C\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges).toHaveLength(2);
      expect(result.model.edges[0].sourceId).toBe('A');
      expect(result.model.edges[0].targetId).toBe('B');
      expect(result.model.edges[1].sourceId).toBe('B');
      expect(result.model.edges[1].targetId).toBe('C');
    }
  });

  it('splits a longer chain (A --> B --> C --> D) into three edges, in order', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B --> C --> D\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges.map((e) => [e.sourceId, e.targetId])).toEqual([
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
      ]);
    }
  });

  it('allows a chain to mix connector types per hop', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B -.-> C\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges[0].lineStyle).toBeUndefined();
      expect(result.model.edges[1].lineStyle).toBe('dotted');
    }
  });

  it('splits a fan-out edge line (A --> B & C) into two edges sharing the same source', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B & C\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges).toHaveLength(2);
      expect(result.model.edges[0].sourceId).toBe('A');
      expect(result.model.edges[0].targetId).toBe('B');
      expect(result.model.edges[1].sourceId).toBe('A');
      expect(result.model.edges[1].targetId).toBe('C');
    }
  });

  it('splits a fan-out with more than two targets (A --> B & C & D)', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B & C & D\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges.map((e) => e.targetId)).toEqual(['B', 'C', 'D']);
      expect(result.model.edges.every((e) => e.sourceId === 'A')).toBe(true);
    }
  });

  it('applies a dotted fan-out connector to every expanded edge', () => {
    const result = parseFlowchart('flowchart TD\n  A -.-> B & C\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges.every((e) => e.lineStyle === 'dotted')).toBe(true);
    }
  });

  it('creates implicit rectangle nodes for every endpoint in a chain or fan-out, same as a plain edge', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B --> C\n  X --> Y & Z\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const ids = result.model.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(['A', 'B', 'C', 'X', 'Y', 'Z']);
    }
  });
});
