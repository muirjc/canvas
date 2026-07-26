import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * FR-005 / FR-019: parse() must never throw, and unmapped/unsupported syntax must be reported
 * with enough location/content detail to explain specifically what could not be interpreted —
 * never a silent drop, never a generic failure.
 */
describe('parseFlowchart error reporting', () => {
  it('never throws on malformed input', () => {
    expect(() => parseFlowchart('this is not mermaid at all {{{')).not.toThrow();
    expect(() => parseFlowchart('')).not.toThrow();
    expect(() => parseFlowchart('flowchart TD\n')).not.toThrow();
  });

  it('reports a structured error with line and content for an unrecognized line', () => {
    const result = parseFlowchart('flowchart TD\n  A[Valid Node]\n  ???not-valid-syntax???\n');
    expect(isParseSuccess(result)).toBe(false);
    if (!isParseSuccess(result)) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatchObject({
        line: 3,
        content: expect.stringContaining('???not-valid-syntax???'),
      });
      expect(result.errors[0].message).toBeTruthy();
    }
  });

  it('reports an error when the diagram header is missing', () => {
    const result = parseFlowchart('  A[Node]\n');
    expect(isParseSuccess(result)).toBe(false);
  });

  it('reports an error for an unmatched "end" with no subgraph', () => {
    const result = parseFlowchart('flowchart TD\nend\n');
    expect(isParseSuccess(result)).toBe(false);
    if (!isParseSuccess(result)) {
      expect(result.errors[0].message).toMatch(/no matching "subgraph"/);
    }
  });
});
