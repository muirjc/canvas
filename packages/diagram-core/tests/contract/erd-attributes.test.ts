import { describe, expect, it } from 'vitest';
import { parseErd, serializeErd } from '../../src/dsl/erd.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

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

  it('does not fail on a trailing quoted comment', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string id PK "the primary key"\n  }\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const customer = result.model.nodes.find((n) => n.id === 'CUSTOMER')!;
      expect(customer.attributes).toEqual([{ type: 'string', name: 'id', keys: ['PK'] }]);
    }
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
 * Pre-existing, documented scope limitation (see parseErd's own doc comment): DiagramEdge has no
 * cardinality field, so serialization always normalizes to the common one-to-many token
 * (`||--o{`) regardless of the cardinality notation originally imported. Not a bug to fix here —
 * this test only confirms the documented behavior still holds.
 */
describe('erd parser/serializer: cardinality normalization (documented limitation)', () => {
  it('normalizes a non-default imported cardinality to the default one-to-many token on serialize', () => {
    const dsl = 'erDiagram\n  CUSTOMER ||--|| ORDER : owns\n';
    const result = parseErd(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.edges).toHaveLength(1);

    const serialized = serializeErd(result.model);
    expect(serialized).toContain('CUSTOMER ||--o{ ORDER : owns');
    expect(serialized).not.toContain('||--||');
  });
});
