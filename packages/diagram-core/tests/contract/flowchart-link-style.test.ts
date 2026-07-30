import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * Feature: Mermaid's `linkStyle <index[,index...]|default> <prop>:<value>,...` directive styles
 * edges the way `style <nodeId> ...` already styles nodes — but edges have no DSL-level id, so
 * Mermaid addresses them by their 0-based declaration order instead (the Nth `-->`/`---`/etc. line
 * encountered is link N), not by the platform's internal `eN` ids.
 */
describe('flowchart parser: linkStyle directive', () => {
  it('applies stroke, stroke-width, and stroke-dasharray to the edge at the given index', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start] --> B[End]\n  linkStyle 0 stroke:#ff0000,stroke-width:4px,stroke-dasharray:5 5\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.style?.strokeColor).toBe('#ff0000');
      expect(edge.style?.strokeWidth).toBe(4);
      expect(edge.style?.strokeDasharray).toBe('5 5');
    }
  });

  it('addresses edges by 0-based declaration order, not by the internal e1/e2 id numbering', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A --> B\n  B --> C\n  C --> D\n  linkStyle 1 stroke:#00ff00\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges[0].style?.strokeColor).toBeUndefined();
      expect(result.model.edges[1].style?.strokeColor).toBe('#00ff00');
      expect(result.model.edges[2].style?.strokeColor).toBeUndefined();
    }
  });

  it('applies a single linkStyle line to a comma-separated list of indices', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B\n  B --> C\n  C --> D\n  linkStyle 0,2 stroke:#0000ff\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges[0].style?.strokeColor).toBe('#0000ff');
      expect(result.model.edges[1].style?.strokeColor).toBeUndefined();
      expect(result.model.edges[2].style?.strokeColor).toBe('#0000ff');
    }
  });

  it('applies "linkStyle default" to every edge', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B\n  B --> C\n  linkStyle default stroke-width:2px\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges[0].style?.strokeWidth).toBe(2);
      expect(result.model.edges[1].style?.strokeWidth).toBe(2);
    }
  });

  it('is a no-op for an index with no corresponding edge, rather than failing the parse', () => {
    const result = parseFlowchart('flowchart TD\n  A --> B\n  linkStyle 5 stroke:#ff0000\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges).toHaveLength(1);
      expect(result.model.edges[0].style?.strokeColor).toBeUndefined();
    }
  });

  it('accepts a linkStyle line declared before the edges it targets', () => {
    const result = parseFlowchart('flowchart TD\n  linkStyle 0 stroke:#ff0000\n  A --> B\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges[0].style?.strokeColor).toBe('#ff0000');
    }
  });
});
