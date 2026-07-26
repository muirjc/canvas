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
