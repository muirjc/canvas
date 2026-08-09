import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * Grouping C (docs/flowchart-completeness-brief.md): Mermaid's `classDef <name> <props>` defines
 * a named style, and `class <id1>,<id2>,... <name>` assigns it to one or more nodes. Same
 * import-compatibility shape as the existing `style` directive (feature 002): folds into the
 * node's existing `NodeStyle` and round-trips via front-matter, never re-emitted as `classDef`/
 * `class` lines on serialize.
 */
describe('flowchart parser: classDef/class styling', () => {
  it('applies a classDef style to a node referenced by a class line', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f,stroke:#333\n  class A highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.style?.fillColor).toBe('#f9f');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('applies one class line to a comma-separated list of node ids', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  B[Middle]\n  C[End]\n  classDef highlight fill:#f9f\n  class A,B highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f9f');
      expect(result.model.nodes.find((n) => n.id === 'B')!.style?.fillColor).toBe('#f9f');
      expect(result.model.nodes.find((n) => n.id === 'C')!.style?.fillColor).toBeUndefined();
    }
  });

  it('resolves a class line that appears before the classDef it references', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  class A highlight\n  classDef highlight fill:#f9f\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f9f');
    }
  });

  it('applies distinct classDefs to distinct nodes without cross-contamination', () => {
    const result = parseFlowchart(
      [
        'flowchart TD',
        '  A[Start]',
        '  B[End]',
        '  classDef red fill:#f00',
        '  classDef blue fill:#00f',
        '  class A red',
        '  class B blue',
        '',
      ].join('\n'),
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f00');
      expect(result.model.nodes.find((n) => n.id === 'B')!.style?.fillColor).toBe('#00f');
    }
  });

  it('lets an explicit style directive on the same node override its class-applied properties', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f,stroke:#333\n  class A highlight\n  style A fill:#000\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.style?.fillColor).toBe('#000');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('accepts a classDef property it does not model (e.g. font-weight) without failing the parse', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f,font-weight:bold\n  class A highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f9f');
    }
  });

  it('is a no-op for a class line naming a classDef that was never defined', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  class A ghost\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style).toBeUndefined();
    }
  });

  it('is a no-op for a class line referencing a node id not otherwise present', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f\n  class Z highlight\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.map((n) => n.id)).toEqual(['A']);
    }
  });

  it('accepts trailing semicolons on both classDef and class lines', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f;\n  class A highlight;\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f9f');
    }
  });

  it('does not misread a "classDef" line as a "class" assignment or vice versa', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f\n  class A highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes).toHaveLength(1);
      expect(result.model.nodes[0].style?.fillColor).toBe('#f9f');
    }
  });
});

/**
 * jmuir-dzd.2: the `id:::className` shorthand, equivalent to a separate `class id className`
 * line — already supported by erd.ts/uml.ts, added here for parity. Reuses the exact same
 * `classAssignments`/`classDefs` resolution path as the explicit `class` directive above, so most
 * of these mirror that describe block's own cases one-for-one.
 */
describe('flowchart parser: ::: class shorthand', () => {
  it('applies a classDef style to a node referenced via the ::: shorthand', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f,stroke:#333\n  A:::highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.style?.fillColor).toBe('#f9f');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('creates an implicit rectangle node for an id referenced only via the ::: shorthand', () => {
    const result = parseFlowchart('flowchart TD\n  classDef highlight fill:#f9f\n  A:::highlight\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node).toBeDefined();
      expect(node.shape).toBe('rectangle');
      expect(node.label).toBe('A');
      expect(node.style?.fillColor).toBe('#f9f');
    }
  });

  it('resolves the ::: shorthand as a forward reference to a classDef declared later in the file', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  A:::highlight\n  classDef highlight fill:#f9f\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f9f');
    }
  });

  it('is a no-op for a ::: shorthand naming a classDef that was never defined', () => {
    const result = parseFlowchart('flowchart TD\n  A[Start]\n  A:::ghost\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node).toBeDefined();
      expect(node.style).toBeUndefined();
    }
  });

  it('lets an explicit style directive on the same node override the ::: shorthand-applied style', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f,stroke:#333\n  A:::highlight\n  style A fill:#000\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.style?.fillColor).toBe('#000');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('round-trips a ::: shorthand-applied style through canvas.styles front matter, not a literal ::: line', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef highlight fill:#f9f,stroke:#333\n  A:::highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const dsl = serializeFlowchart(result.model);
    expect(dsl).toContain('styles:');
    expect(dsl).not.toMatch(/:::/);
    expect(dsl).not.toMatch(/^\s*classDef/m);

    const reparsed = parseFlowchart(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      const node = reparsed.model.nodes.find((n) => n.id === 'A')!;
      expect(node.style?.fillColor).toBe('#f9f');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('accepts a comma-separated list of class names after ::: and applies only the first (this codebase\'s own lenient convention, not real Mermaid grammar)', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]\n  classDef foo fill:#f00\n  classDef bar fill:#00f\n  A:::foo,bar\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f00');
    }
  });

  it('does not interfere with plain node declarations or the pre-existing explicit "class id className" form used in the same file', () => {
    const result = parseFlowchart(
      [
        'flowchart TD',
        '  A[Start]',
        '  B[Middle]',
        '  C:::highlight',
        '  classDef highlight fill:#f9f',
        '  class B highlight',
        '  A --> B',
        '',
      ].join('\n'),
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C']);
      expect(result.model.nodes.find((n) => n.id === 'A')!.style).toBeUndefined();
      expect(result.model.nodes.find((n) => n.id === 'B')!.style?.fillColor).toBe('#f9f');
      expect(result.model.nodes.find((n) => n.id === 'C')!.style?.fillColor).toBe('#f9f');
    }
  });
});
