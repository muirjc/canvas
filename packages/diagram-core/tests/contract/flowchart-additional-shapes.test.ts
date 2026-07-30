import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { NodeShape } from '../../src/model/diagram-model.js';

/**
 * Feature 009: nine additional flowchart node shapes (grouping A of
 * docs/flowchart-completeness-brief.md), deferred by feature 002's own Assumptions section.
 * See contracts/dsl-grammar-contract.md for the full syntax table and the five collision-pair
 * regressions this file exists to catch.
 */
describe('flowchart parser: additional node shapes', () => {
  const cases: { dsl: string; shape: NodeShape }[] = [
    { dsl: 'A([Start])', shape: 'stadium' },
    { dsl: 'A[[Start]]', shape: 'subroutine' },
    { dsl: 'A(((Start)))', shape: 'double-circle' },
    { dsl: 'A{{Start}}', shape: 'hexagon' },
    { dsl: 'A[/Start/]', shape: 'parallelogram' },
    { dsl: 'A[\\Start\\]', shape: 'parallelogram-alt' },
    { dsl: 'A[/Start\\]', shape: 'trapezoid' },
    { dsl: 'A[\\Start/]', shape: 'trapezoid-alt' },
    { dsl: 'A>Start]', shape: 'asymmetric' },
  ];

  for (const { dsl, shape } of cases) {
    it(`recognizes ${shape} (${dsl})`, () => {
      const result = parseFlowchart(`flowchart TD\n  ${dsl}\n`);
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'A')!;
        expect(node.shape).toBe(shape);
        expect(node.label).toBe('Start');
      }
    });
  }

  it('recognizes a shape declared inline at an edge endpoint, same as a standalone declaration', () => {
    const result = parseFlowchart('flowchart TD\n  A([Start]) --> B\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.shape).toBe('stadium');
      expect(node.label).toBe('Start');
    }
  });

  it('imports a single document containing all nine shapes at once', () => {
    const dsl = [
      'flowchart TD',
      '  A([Stadium])',
      '  B[[Subroutine]]',
      '  C(((DoubleCircle)))',
      '  D{{Hexagon}}',
      '  E[/Parallelogram/]',
      '  F[\\ParallelogramAlt\\]',
      '  G[/Trapezoid\\]',
      '  H[\\TrapezoidAlt/]',
      '  I>Asymmetric]',
      '',
    ].join('\n');
    const result = parseFlowchart(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const shapeOf = (id: string) => result.model.nodes.find((n) => n.id === id)!.shape;
      expect(shapeOf('A')).toBe('stadium');
      expect(shapeOf('B')).toBe('subroutine');
      expect(shapeOf('C')).toBe('double-circle');
      expect(shapeOf('D')).toBe('hexagon');
      expect(shapeOf('E')).toBe('parallelogram');
      expect(shapeOf('F')).toBe('parallelogram-alt');
      expect(shapeOf('G')).toBe('trapezoid');
      expect(shapeOf('H')).toBe('trapezoid-alt');
      expect(shapeOf('I')).toBe('asymmetric');
    }
  });

  describe('collision-pair regressions (data-model.md ordering table)', () => {
    it('does not misread subroutine [[..]] as a rectangle labeled [..]', () => {
      const result = parseFlowchart('flowchart TD\n  A[[Start]]\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'A')!;
        expect(node.shape).toBe('subroutine');
        expect(node.label).toBe('Start');
      }
    });

    it('does not misread stadium (..) as a rounded-rectangle labeled [..]', () => {
      const result = parseFlowchart('flowchart TD\n  A([Start])\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'A')!;
        expect(node.shape).toBe('stadium');
        expect(node.label).toBe('Start');
      }
    });

    it('does not misread double-circle (((..))) as a circle labeled (..)', () => {
      const result = parseFlowchart('flowchart TD\n  A(((Start)))\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'A')!;
        expect(node.shape).toBe('double-circle');
        expect(node.label).toBe('Start');
      }
    });

    it('does not misread hexagon {{..}} as a diamond labeled {..}', () => {
      const result = parseFlowchart('flowchart TD\n  A{{Start}}\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'A')!;
        expect(node.shape).toBe('hexagon');
        expect(node.label).toBe('Start');
      }
    });

    it('does not misread a parallelogram/trapezoid as a rectangle labeled with a leading/trailing slash', () => {
      const result = parseFlowchart('flowchart TD\n  A[/Start/]\n  B[/Start\\]\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.nodes.find((n) => n.id === 'A')!.shape).toBe('parallelogram');
        expect(result.model.nodes.find((n) => n.id === 'B')!.shape).toBe('trapezoid');
      }
    });

    it('does not misread a genuine rectangle whose label merely starts with a slash as a parallelogram', () => {
      // No closing "/]" or "\]" pair — this is a plain rectangle whose label happens to start
      // with "/", the reverse direction of the ambiguity above.
      const result = parseFlowchart('flowchart TD\n  A[/not-a-parallelogram]\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'A')!;
        expect(node.shape).toBe('rectangle');
        expect(node.label).toBe('/not-a-parallelogram');
      }
    });
  });
});
