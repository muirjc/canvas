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

/**
 * jmuir-dzd.3: the `:::className` shorthand (jmuir-dzd.2) combined with an inline shape+label
 * declaration on the SAME token (`A[Label]:::className`), both as a standalone node-declaration
 * line and as an edge endpoint (`A[Label]:::className --> B`) -- confirmed to fail with a clean
 * parse error before this fix, per jmuir-dzd.2's own disclosed scope boundary.
 */
describe('flowchart parser: ::: shorthand combined with an inline shape+label', () => {
  it('applies a classDef style to a node declared with an inline shape+label on the same line', () => {
    const result = parseFlowchart(
      'flowchart TD\n  classDef highlight fill:#f9f,stroke:#333\n  A[Start]:::highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.shape).toBe('rectangle');
      expect(node.label).toBe('Start');
      expect(node.style?.fillColor).toBe('#f9f');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('works for every shape delimiter, not just rectangle', () => {
    const result = parseFlowchart(
      [
        'flowchart TD',
        '  classDef hl fill:#f9f',
        '  A(Rounded):::hl',
        '  B((Circle)):::hl',
        '  C{Diamond}:::hl',
        '  D([Stadium]):::hl',
        '  E[(Cylinder)]:::hl',
        '  F[[Subroutine]]:::hl',
        '  G(((DoubleCircle))):::hl',
        '  H{{Hexagon}}:::hl',
        '  I[/Parallelogram/]:::hl',
        '  J[\\ParallelogramAlt\\]:::hl',
        '  K[/Trapezoid\\]:::hl',
        '  L[\\TrapezoidAlt/]:::hl',
        '  M>Asymmetric]:::hl',
        '',
      ].join('\n'),
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']) {
        expect(result.model.nodes.find((n) => n.id === id)?.style?.fillColor).toBe('#f9f');
      }
    }
  });

  it('applies the class to an inline shape+label declared at an edge endpoint', () => {
    const result = parseFlowchart(
      'flowchart TD\n  classDef highlight fill:#f9f\n  A[Start]:::highlight --> B\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const a = result.model.nodes.find((n) => n.id === 'A')!;
      expect(a.label).toBe('Start');
      expect(a.shape).toBe('rectangle');
      expect(a.style?.fillColor).toBe('#f9f');
      expect(result.model.edges).toHaveLength(1);
      expect(result.model.edges[0]).toMatchObject({ sourceId: 'A', targetId: 'B' });
    }
  });

  it('applies the class to a bare-id (no shape) edge endpoint, mirroring the standalone bare-id form', () => {
    const result = parseFlowchart(
      'flowchart TD\n  classDef highlight fill:#f9f\n  A:::highlight --> B\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f9f');
    }
  });

  it('resolves as a forward reference to a classDef declared later in the file', () => {
    const result = parseFlowchart(
      'flowchart TD\n  A[Start]:::highlight --> B\n  classDef highlight fill:#f9f\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'A')!.style?.fillColor).toBe('#f9f');
    }
  });

  it('does not treat a literal ":::" inside label text (with no trailing class name outside the shape) as the shorthand', () => {
    const result = parseFlowchart('flowchart TD\n  A[foo:::bar]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.label).toBe('foo:::bar');
      expect(node.style).toBeUndefined();
    }
  });

  it('round-trips the applied style through canvas.styles front matter, not a literal ":::" line', () => {
    const result = parseFlowchart(
      'flowchart TD\n  classDef highlight fill:#f9f,stroke:#333\n  A[Start]:::highlight\n',
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
      expect(node.label).toBe('Start');
      expect(node.style?.fillColor).toBe('#f9f');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('lets an explicit style directive on the same node override the shorthand-applied style', () => {
    const result = parseFlowchart(
      'flowchart TD\n  classDef highlight fill:#f9f,stroke:#333\n  A[Start]:::highlight\n  style A fill:#000\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'A')!;
      expect(node.style?.fillColor).toBe('#000');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });
});
