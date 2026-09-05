import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * Feature 002, User Story 5: "graph" is a documented Mermaid synonym for "flowchart" — importing
 * either must produce an identical result (FR-016). Also covers `%%` comment lines (FR-018),
 * which must never fail an otherwise-valid import.
 */
describe('flowchart parser: "graph" header alias', () => {
  for (const direction of ['TD', 'LR', 'TB', 'RL', 'BT']) {
    it(`accepts "graph ${direction}" identically to "flowchart ${direction}"`, () => {
      const graphResult = parseFlowchart(`graph ${direction}\n  A[Start]\n  B[End]\n  A --> B\n`);
      const flowchartResult = parseFlowchart(`flowchart ${direction}\n  A[Start]\n  B[End]\n  A --> B\n`);
      expect(isParseSuccess(graphResult)).toBe(true);
      expect(isParseSuccess(flowchartResult)).toBe(true);
      if (isParseSuccess(graphResult) && isParseSuccess(flowchartResult)) {
        expect(graphResult.model).toEqual(flowchartResult.model);
      }
    });
  }

  it('preserves the original direction (not just TD) through a round-trip', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      direction: 'LR',
      nodes: [{ id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    };
    const dsl = serializeFlowchart(model);
    expect(dsl).toContain('flowchart LR');

    const reparsed = parseFlowchart(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.direction).toBe('LR');
    }
  });

  it('skips %% comment lines rather than treating them as unrecognized content', () => {
    const result = parseFlowchart('graph TD\n  %% this is a comment\n  A[Start]\n  %% another one\n  B[End]\n  A --> B\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    }
  });

  it('still reports a specific error for genuinely unrecognized content alongside a graph header', () => {
    const result = parseFlowchart('graph TD\n  A[Start]\n  ???not-valid???\n');
    expect(isParseSuccess(result)).toBe(false);
    if (!isParseSuccess(result)) {
      expect(result.errors[0].content).toContain('???not-valid???');
    }
  });
});

// canvas-vtg: 'title <text>' now recognized outside C4 too (canvas-79b introduced it there
// first) -- previously hard-errored the whole parse for every one of the other 5 families.
describe('flowchart parser: "title" directive (canvas-vtg)', () => {
  it('parses a top-level "title" line and round-trips it through serialize -> reparse', () => {
    const result = parseFlowchart('flowchart TD\n  title My Diagram\n  A[Start]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBe('My Diagram');

    const reparsed = parseFlowchart(serializeFlowchart(result.model));
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.title).toBe('My Diagram');
  });

  it('a model with no title omits the "title" line entirely on serialize (no regression)', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBeUndefined();
    expect(serializeFlowchart(result.model)).not.toContain('title');
  });
});
