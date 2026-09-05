import { describe, expect, it } from 'vitest';
import { parseErd, serializeErd } from '../../src/dsl/erd.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { createEmptyDiagramModel, type DiagramModel } from '../../src/model/diagram-model.js';

/**
 * Feature 003, User Story 2: ER diagrams must support entity attribute blocks
 * (`ENTITY { type name PK/FK/UK }`) — currently unparseable, the single biggest real-world ER
 * gap (FR-005–FR-008, FR-018).
 */
describe('erd parser: attribute blocks', () => {
  it('parses an attribute block with type, name, and a PK marker', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string id PK\n    string name\n  }\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const customer = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(customer.attributes).toEqual([
        { type: 'string', name: 'id', keys: ['PK'] },
        { type: 'string', name: 'name', keys: [] },
      ]);
    }
  });

  it('parses multiple key markers on one attribute', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string email UK, FK\n  }\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const customer = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(customer.attributes).toEqual([{ type: 'string', name: 'email', keys: ['UK', 'FK'] }]);
    }
  });

  it('does not fail on an unrecognized constraint keyword', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string status ACTIVE\n  }\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const customer = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(customer.attributes).toEqual([{ type: 'string', name: 'status', keys: [] }]);
    }
  });

  // Previously discarded entirely (asserted as "doesn't crash," never that the comment survives)
  // — Mermaid's own docs describe this as descriptive metadata that "does not impact the
  // rendering of the diagram," but it must still round-trip like any other authored content
  // (FR-003). Fixed alongside canvas-2ut's cardinality fix.
  it('captures a trailing quoted comment and round-trips it through export and re-import', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string id PK "the primary key"\n  }\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const customer = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
    expect(customer.attributes).toEqual([{ type: 'string', name: 'id', keys: ['PK'], comment: 'the primary key' }]);

    const serialized = serializeErd(result.model);
    expect(serialized).toContain('string id PK "the primary key"');

    const reparsed = parseErd(serialized);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.nodes.find((n) => n.id === 'CUSTOMER')!.attributes).toEqual([
      { type: 'string', name: 'id', keys: ['PK'], comment: 'the primary key' },
    ]);
  });

  it('an attribute with no comment round-trips with no comment field at all (no regression)', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string id PK\n  }\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    const customer = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
    expect(customer.attributes![0].comment).toBeUndefined();
    expect(serializeErd(result.model)).toContain('string id PK\n');
  });

  it('round-trips attribute type/name/keys through export and re-import', () => {
    const model: DiagramModel = {
      diagramTypeId: 'erd',
      nodes: [
        {
          id: 'CUSTOMER',
          label: 'CUSTOMER',
          shape: 'rectangle',
          role: 'entity',
          position: { x: 0, y: 0 },
          attributes: [
            { type: 'string', name: 'id', keys: ['PK'] },
            { type: 'string', name: 'name', keys: [] },
          ],
        },
      ],
      edges: [],
      containers: [],
    };
    const dsl = serializeErd(model);
    const reparsed = parseErd(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.nodes[0].attributes).toEqual(model.nodes[0].attributes);
    }
  });

  it('a diagram using only the pre-existing bare relationship form is unchanged', () => {
    const dsl = 'erDiagram\nCUSTOMER ||--o{ ORDER : places\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'CUSTOMER')!.attributes).toBeUndefined();
      expect(result.model.edges).toHaveLength(1);
    }
  });

  it('reports a structured error for an unclosed attribute block', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string id PK\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(false);
    if (!isParseSuccess(result)) {
      // Must be the specific unclosed-block error, not the generic "unrecognized line"
      // fallback (which would fire once per line inside the block and only coincidentally
      // mention the entity name via raw line content).
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message.toLowerCase()).toContain('unclosed');
      expect(result.errors[0].message).toContain('CUSTOMER');
      expect(result.errors[0].line).toBe(2);
    }
  });
});

/**
 * jmuir-dtu.6: entity aliases. `id[Alias Label]` — standalone, or combined with an attribute
 * block start (`id[Alias Label] {`) — sets `node.label` while `node.id` stays the identifier
 * used everywhere else. Order-independent: an alias declared anywhere in the file applies,
 * including after the entity is first referenced by a relationship; referencing an already-
 * aliased entity again with no alias must never clobber the alias back to the bare id.
 */
describe('erd parser: entity aliases', () => {
  it('applies a standalone alias declaration to the label, leaving the id unchanged', () => {
    const result = parseErd('erDiagram\n  p[Person]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'p')!;
      expect(node.id).toBe('p');
      expect(node.label).toBe('Person');
    }
  });

  it('round-trips a standalone alias through serialize and re-parse', () => {
    const result = parseErd('erDiagram\n  p[Person]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const dsl = serializeErd(result.model);
    const reparsed = parseErd(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      const node = reparsed.model.nodes.find((n) => n.id === 'p')!;
      expect(node.id).toBe('p');
      expect(node.label).toBe('Person');
    }
  });

  it('applies an alias on a combined attribute-block start line, preserving the attributes', () => {
    const dsl = 'erDiagram\n  p[Person] {\n    string name\n    int age\n  }\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const node = result.model.nodes.find((n) => n.id === 'p')!;
    expect(node.label).toBe('Person');
    expect(node.attributes).toEqual([
      { type: 'string', name: 'name', keys: [] },
      { type: 'int', name: 'age', keys: [] },
    ]);

    const reparsed = parseErd(serializeErd(result.model));
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      const reparsedNode = reparsed.model.nodes.find((n) => n.id === 'p')!;
      expect(reparsedNode.label).toBe('Person');
      expect(reparsedNode.attributes).toEqual(node.attributes);
    }
  });

  it('resolves an alias declared after the entity is first referenced by a relationship (order independence)', () => {
    // Regression test: the alias must apply even though `p` is referenced by the relationship
    // line before its own `p[Person]` alias line appears later in the file.
    const dsl = 'erDiagram\n  p ||--o{ o : places\n  p[Person]\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'p')!;
      expect(node.label).toBe('Person');
    }
  });

  it('does not clobber an already-set alias when the entity is referenced again with no alias', () => {
    const dsl = 'erDiagram\n  p[Person]\n  p ||--o{ o : places\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'p')!;
      expect(node.label).toBe('Person');
    }
  });
});

/**
 * jmuir-dtu.6: an entity with no attribute block and no relationship (a bare alias-only
 * declaration, or any other standalone entity) used to vanish entirely on `serializeErd` — a
 * real bug, not just missing syntax. Regression tests, not incidental coverage.
 */
describe('erd parser/serializer: standalone entity declarations', () => {
  it('round-trips a bare entity with no alias, attributes, or relationship instead of vanishing', () => {
    const result = parseErd('erDiagram\n  CUSTOMER\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.nodes.map((n) => n.id)).toEqual(['CUSTOMER']);

    const dsl = serializeErd(result.model);
    const reparsed = parseErd(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.nodes.map((n) => n.id)).toEqual(['CUSTOMER']);
      expect(reparsed.model.nodes[0].label).toBe('CUSTOMER');
    }
  });

  it('round-trips an alias-only entity (no attributes, no relationship) back to its bracketed form', () => {
    const result = parseErd('erDiagram\n  p[Person]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const dsl = serializeErd(result.model);
    expect(dsl).toMatch(/p\[Person\]/);

    const reparsed = parseErd(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      const node = reparsed.model.nodes.find((n) => n.id === 'p')!;
      expect(node.label).toBe('Person');
    }
  });
});

/**
 * jmuir-dtu.6: `direction TB|BT|LR|RL` — a top-level statement setting `model.direction`,
 * round-tripped by `serializeErd` as a `direction <X>` line right after the `erDiagram` header.
 */
describe('erd parser: direction', () => {
  it.each(['LR', 'TB', 'BT', 'RL'] as const)('parses and round-trips "direction %s"', (dir) => {
    const result = parseErd(`erDiagram\n  direction ${dir}\n  CUSTOMER ||--o{ ORDER : places\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.direction).toBe(dir);

    const dsl = serializeErd(result.model);
    expect(dsl).toContain(`direction ${dir}`);

    const reparsed = parseErd(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.direction).toBe(dir);
    }
  });

  it('canonicalizes a lowercase direction token to uppercase', () => {
    const result = parseErd('erDiagram\n  direction lr\n  CUSTOMER\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.direction).toBe('LR');
    }
  });

  it('leaves model.direction undefined when no direction line is present', () => {
    const result = parseErd('erDiagram\n  CUSTOMER\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.direction).toBeUndefined();
    }
  });
});

/**
 * jmuir-dtu.6: `style <entityId> <props>`, `classDef <name> <props>` + `class <ids> <name>`, and
 * the `id:::className` / `id[Alias]:::className` shorthand — mirrors flowchart-parser.ts's own
 * style/classDef second pass exactly (see flowchart-classdef.test.ts / flowchart-style-
 * directive.test.ts for the idiom this follows), folding into the existing NodeStyle fill/
 * stroke fields.
 */
describe('erd parser: style/classDef/class styling', () => {
  it('applies fill/stroke/stroke-width/stroke-dasharray from a style directive to the referenced entity', () => {
    const result = parseErd(
      'erDiagram\n  CUSTOMER\n  style CUSTOMER fill:#e1f5fe,stroke:#0288d1,stroke-width:2,stroke-dasharray:5 5\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(node.style?.fillColor).toBe('#e1f5fe');
      expect(node.style?.strokeColor).toBe('#0288d1');
      expect(node.style?.strokeWidth).toBe(2);
      expect(node.style?.strokeDasharray).toBe('5 5');
    }
  });

  it('resolves a class line that appears before the classDef it references (forward reference)', () => {
    const result = parseErd(
      'erDiagram\n  CUSTOMER\n  class CUSTOMER highlight\n  classDef highlight fill:#f9f,stroke:#333\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(node.style?.fillColor).toBe('#f9f');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('applies one class line to a comma-separated list of entity ids', () => {
    const result = parseErd(
      'erDiagram\n  CUSTOMER\n  ORDER\n  PRODUCT\n  classDef highlight fill:#f9f\n  class CUSTOMER,ORDER highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'CUSTOMER')!.style?.fillColor).toBe('#f9f');
      expect(result.model.nodes.find((n) => n.id === 'ORDER')!.style?.fillColor).toBe('#f9f');
      expect(result.model.nodes.find((n) => n.id === 'PRODUCT')!.style?.fillColor).toBeUndefined();
    }
  });

  it('applies the ::: shorthand (bare id form) to a classDef declared later in the file', () => {
    // Forward reference: `CUSTOMER:::highlight` appears before its `classDef` line.
    const result = parseErd('erDiagram\n  CUSTOMER:::highlight\n  classDef highlight fill:#f9f\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(node.id).toBe('CUSTOMER');
      expect(node.style?.fillColor).toBe('#f9f');
    }
  });

  it('applies the ::: shorthand with an alias, setting both the label and the style', () => {
    // Forward reference again, this time on the aliased shorthand form.
    const result = parseErd('erDiagram\n  p[Person]:::highlight\n  classDef highlight fill:#f9f\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'p')!;
      expect(node.label).toBe('Person');
      expect(node.style?.fillColor).toBe('#f9f');
    }
  });

  it('lets an explicit style directive override a class-applied property on the same entity', () => {
    const result = parseErd(
      'erDiagram\n  CUSTOMER\n  classDef highlight fill:#f9f,stroke:#333\n  class CUSTOMER highlight\n  style CUSTOMER fill:#000\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(node.style?.fillColor).toBe('#000');
      expect(node.style?.strokeColor).toBe('#333');
    }
  });

  it('silently skips a style directive referencing an entity id not otherwise present', () => {
    const result = parseErd('erDiagram\n  CUSTOMER\n  style GHOST fill:#000\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.map((n) => n.id)).toEqual(['CUSTOMER']);
    }
  });

  it('silently skips a class assignment referencing an entity id not otherwise present', () => {
    const result = parseErd(
      'erDiagram\n  CUSTOMER\n  classDef highlight fill:#f9f\n  class GHOST highlight\n',
    );
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.map((n) => n.id)).toEqual(['CUSTOMER']);
    }
  });

  it('is a no-op for a class line naming a classDef that was never defined', () => {
    const result = parseErd('erDiagram\n  CUSTOMER\n  class CUSTOMER ghost\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.nodes.find((n) => n.id === 'CUSTOMER')!.style).toBeUndefined();
    }
  });
});

/**
 * jmuir-dtu.6: entity styles now round-trip via a `canvas.styles` front-matter block — a
 * previously entirely-absent gap in `serializeErd`'s front matter, closed alongside style/
 * classDef/class support since without it no entity style could ever round-trip regardless of
 * source syntax. Styles are never re-emitted as `style`/`classDef`/`class` lines on serialize.
 */
describe('erd serializer: entity style front-matter round-trip', () => {
  it('round-trips an entity style declared via a style directive through canvas.styles front matter', () => {
    const result = parseErd('erDiagram\n  CUSTOMER\n  style CUSTOMER fill:#e1f5fe,stroke:#0288d1\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const dsl = serializeErd(result.model);
    expect(dsl).toContain('canvas:');
    expect(dsl).toContain('styles:');
    // Not re-emitted as a literal `style` directive line in the body.
    expect(dsl).not.toMatch(/^\s*style\s+CUSTOMER/m);

    const reparsed = parseErd(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      const node = reparsed.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(node.style?.fillColor).toBe('#e1f5fe');
      expect(node.style?.strokeColor).toBe('#0288d1');
    }
  });

  it('round-trips no per-entity style when no entity has one (styles map stays empty)', () => {
    // Front matter's `styles` key is always present (same as flowchart-serializer.ts's own
    // front-matter shape) but keyed only by entities that actually have a style — an entity with
    // none must not gain one after a round-trip.
    const result = parseErd('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    const dsl = serializeErd(result.model);
    const reparsed = parseErd(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.nodes.every((n) => n.style === undefined)).toBe(true);
    }
  });
});

/**
 * jmuir-dtu.6 combined coverage: alias + direction + attribute blocks + relationships +
 * classDef/class + style all together in one file, matching this file's existing round-trip
 * test style (feature 003 attribute round-trip test, above).
 */
describe('erd parser/serializer: combined round-trip', () => {
  it('round-trips alias, direction, attributes, relationships, and styling together', () => {
    const dsl = [
      'erDiagram',
      '  direction LR',
      '  classDef highlight fill:#f9f,stroke:#333',
      '  p[Person] {',
      '    string name',
      '    int age',
      '  }',
      '  o[Order]',
      '  p ||--o{ o : places',
      '  class p highlight',
      '  style o stroke-width:3',
      '',
    ].join('\n');

    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;

    expect(result.model.direction).toBe('LR');
    const person = result.model.nodes.find((n) => n.id === 'p')!;
    expect(person.label).toBe('Person');
    expect(person.attributes).toEqual([
      { type: 'string', name: 'name', keys: [] },
      { type: 'int', name: 'age', keys: [] },
    ]);
    expect(person.style?.fillColor).toBe('#f9f');
    expect(person.style?.strokeColor).toBe('#333');
    const order = result.model.nodes.find((n) => n.id === 'o')!;
    expect(order.label).toBe('Order');
    expect(order.style?.strokeWidth).toBe(3);
    expect(result.model.edges).toHaveLength(1);
    expect(result.model.edges[0]).toMatchObject({ sourceId: 'p', targetId: 'o', label: 'places' });

    const reparsed = parseErd(serializeErd(result.model));
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.direction).toBe('LR');
      const rPerson = reparsed.model.nodes.find((n) => n.id === 'p')!;
      expect(rPerson.label).toBe('Person');
      expect(rPerson.attributes).toEqual(person.attributes);
      expect(rPerson.style?.fillColor).toBe('#f9f');
      expect(rPerson.style?.strokeColor).toBe('#333');
      const rOrder = reparsed.model.nodes.find((n) => n.id === 'o')!;
      expect(rOrder.label).toBe('Order');
      expect(rOrder.style?.strokeWidth).toBe(3);
      expect(reparsed.model.edges).toHaveLength(1);
      expect(reparsed.model.edges[0]).toMatchObject({ sourceId: 'p', targetId: 'o', label: 'places' });
    }
  });
});

/**
 * canvas-2ut: previously a documented scope limitation — DiagramEdge had no cardinality field at
 * all, so serialization always normalized to the common one-to-many token (`||--o{`) regardless
 * of what was actually imported, and neither renderer drew real crow's-foot notation (both a
 * real data-loss bug on re-save and a reported live rendering bug: "the diagram is rendering
 * arrows and it should be rendering crows feet notation"). Now fixed: the real cardinality
 * tokens round-trip exactly via erSourceCardinality/erTargetCardinality.
 */
describe('erd parser/serializer: cardinality round-trips exactly (canvas-2ut)', () => {
  it('captures the real cardinality token on each side, not just the default', () => {
    const dsl = 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.edges).toHaveLength(1);
    expect(result.model.edges[0]).toMatchObject({ erSourceCardinality: '||', erTargetCardinality: 'o{' });
    expect(result.model.edges[0].lineStyle).toBeUndefined();
  });

  it('round-trips a non-default cardinality (exactly-one-to-exactly-one) through serialize -> reparse, unlike before', () => {
    const dsl = 'erDiagram\n  CUSTOMER ||--|| ORDER : owns\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.edges[0]).toMatchObject({ erSourceCardinality: '||', erTargetCardinality: '||' });

    const serialized = serializeErd(result.model);
    expect(serialized).toContain('CUSTOMER ||--|| ORDER : owns');
    expect(serialized).not.toContain('||--o{');

    const reparsed = parseErd(serialized);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.edges[0]).toMatchObject({ erSourceCardinality: '||', erTargetCardinality: '||' });
  });

  it('round-trips a many-to-many relationship with the dashed (non-identifying) line style', () => {
    const dsl = 'erDiagram\n  CUSTOMER }|..|{ ORDER : uses\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.edges[0]).toMatchObject({
      erSourceCardinality: '}|',
      erTargetCardinality: '|{',
      lineStyle: 'dotted',
    });

    const serialized = serializeErd(result.model);
    expect(serialized).toContain('CUSTOMER }|..|{ ORDER : uses');
  });

  it('falls back to the default one-to-many token for an edge with no ER cardinality set (e.g. added via the canvas UI)', () => {
    const model = createEmptyDiagramModel('erd');
    model.nodes.push(
      { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'B', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } },
    );
    model.edges.push({ id: 'e1', sourceId: 'A', targetId: 'B' });

    const serialized = serializeErd(model);
    expect(serialized).toContain('A ||--o{ B :');
  });
});

/**
 * A relationship label may be quoted in real Mermaid (needed if it contains a comma, or just
 * written that way) — previously the literal quote characters were kept as part of the label
 * text and would render visibly, unlike every other quoted-string value elsewhere in this
 * codebase (c4.ts's own macro-arg parsing strips its quotes the same way). Found and fixed
 * alongside canvas-2ut's cardinality fix.
 */
describe('erd parser: quoted relationship labels', () => {
  it('strips surrounding quotes from a fully-quoted label', () => {
    const dsl = 'erDiagram\n  CUSTOMER ||--o{ ORDER : "places, urgently"\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.edges[0].label).toBe('places, urgently');
  });

  it('leaves an unquoted label exactly as written (no regression)', () => {
    const dsl = 'erDiagram\n  CUSTOMER ||--o{ ORDER : places (many)\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.edges[0].label).toBe('places (many)');
  });

  it('leaves a label with an internal, non-wrapping quote untouched', () => {
    const dsl = 'erDiagram\n  CUSTOMER ||--o{ ORDER : has a "special" status\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.edges[0].label).toBe('has a "special" status');
  });
});

// canvas-vtg: 'title <text>' now recognized outside C4 too (canvas-79b introduced it there
// first) -- previously hard-errored the whole parse for every one of the other 5 families.
describe('erd parser: "title" directive (canvas-vtg)', () => {
  it('parses a top-level "title" line and round-trips it through serialize -> reparse', () => {
    const result = parseErd('erDiagram\n  title My Diagram\n  CUSTOMER\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBe('My Diagram');

    const reparsed = parseErd(serializeErd(result.model));
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.title).toBe('My Diagram');
  });

  it('a model with no title omits the "title" line entirely on serialize (no regression)', () => {
    const result = parseErd('erDiagram\n  CUSTOMER\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBeUndefined();
    expect(serializeErd(result.model)).not.toContain('title');
  });
});
