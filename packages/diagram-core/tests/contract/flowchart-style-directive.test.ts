import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * Feature 002, User Story 5: Mermaid's `style <nodeId> <prop>:<value>,...` directive must apply
 * to the referenced node (at least fill/stroke — FR-017) without failing the import, and a
 * `style` line can appear anywhere (typically after node declarations, as real-world Mermaid
 * usually writes it), not just immediately following the node it targets.
 */
describe('flowchart parser: style directive', () => {
  it('applies fill and stroke to the referenced node', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  style A fill:#e1f5fe,stroke:#0288d1\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.style?.fillColor).toBe('#e1f5fe');
      expect(node.style?.strokeColor).toBe('#0288d1');
    }
  });

  it('applies style lines declared at the end of the file to nodes declared earlier', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  B[End]\n  A --> B\n\n  style A fill:#e1f5fe\n  style B fill:#e8f5e8\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#e1f5fe');
      expect(result.model.nodes.find((n) => n.id === 'B')!.style?.fillColor).toBe('#e8f5e8');
    }
  });

  it('accepts a property it does not model (e.g. stroke-width) without failing the parse', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  style A fill:#fff,stroke-width:2px\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#fff');
    }
  });

  it('is a no-op for a style line referencing a node id not otherwise present', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  style Z fill:#fff\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.map((n) => n.id)).toEqual(['A']);
    }
  });

  it('reproduces the spec\'s originally-failing example end to end', () => {
    const dsl = [
      'graph TD',
      '    A[🚀 Welcome to Playground] --> B{Try Mermaid}',
      '    B -->|Edit Code| C[📝 Live Preview]',
      '    B -->|Love It?| D[✨ Sign Up]',
      '    C --> E[🎯 See Changes Instantly]',
      '    D --> F[💾 Save & Export]',
      '',
      '    style A fill:#e1f5fe',
      '    style D fill:#f3e5f5',
      '    style F fill:#e8f5e8',
      '',
    ].join('\n');

    const result = parseFlowchart(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#e1f5fe');
      expect(result.model.nodes.find((n) => n.id === 'D')!.style?.fillColor).toBe('#f3e5f5');
      expect(result.model.nodes.find((n) => n.id === 'F')!.style?.fillColor).toBe('#e8f5e8');
      expect(result.model.nodes.find((n) => n.id === 'A')!.label).toBe('🚀 Welcome to Playground');
      const edgeToC = result.model.edges.find((e) => e.targetId === 'C');
      expect(edgeToC?.label).toBe('Edit Code');
    }
  });
});
