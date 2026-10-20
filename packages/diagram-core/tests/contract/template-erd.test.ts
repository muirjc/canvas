import { describe, expect, it } from 'vitest';
import { parseErd } from '../../src/dsl/erd.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { erdTemplateCompiler } from '../../src/template/erd-template-compiler.js';
import { getTemplateCompiler } from '../../src/template/template-registry.js';
import type { TemplateCompileResult } from '../../src/template/types.js';
import { dslLines, exampleDsl, exampleTables, fillTemplate, readTemplateDoc } from '../fixtures/template-fill.js';

/** canvas-73s.2: docs/erd-template.md -> Mermaid erDiagram. */

const doc = readTemplateDoc('erd-template.md');

function dslOf(result: TemplateCompileResult): string {
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.dsl;
}
const errorsOf = (result: TemplateCompileResult) => ('errors' in result ? result.errors.map((e) => e.message) : []);

describe('ERD template compiler', () => {
  it('is registered for the erd diagram type', () => {
    expect(getTemplateCompiler('erd')).toBe(erdTemplateCompiler);
  });

  it("compiles the doc's own worked example to the DSL the doc shows, and the model is right", () => {
    const [entities, attributes, relationships] = exampleTables(doc);
    const dsl = dslOf(erdTemplateCompiler.compile(fillTemplate(doc, { entities, attributes, relationships })));
    expect(dslLines(dsl)).toEqual(dslLines(exampleDsl(doc)));

    const parsed = parseErd(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    const line = parsed.model.nodes.find((n) => n.id === 'Order_Line')!;
    expect(line.label).toBe('Order Line');
    const customer = parsed.model.nodes.find((n) => n.id === 'Customer')!;
    expect(customer.attributes).toEqual([
      expect.objectContaining({ type: 'string', name: 'id', keys: ['PK'] }),
      expect.objectContaining({ type: 'string', name: 'email', keys: ['UK'], comment: 'Login name' }),
    ]);
    expect(parsed.model.edges.map((e) => e.label)).toEqual(['places', 'contains']);
  });

  it('title, direction, several keys, an entity with no attributes, and the default label', () => {
    const dsl = dslOf(
      erdTemplateCompiler.compile(
        fillTemplate(doc, {
          'diagram metadata': [
            ['Diagram title', 'Orders'],
            ['Direction (Top to bottom / Left to right / Bottom to top / Right to left)', 'Left to right'],
          ],
          entities: [['Order'], ['Audit Log']],
          attributes: [['Order', 'customer id', 'decimal(10, 2)', 'PK, FK', '']],
          relationships: [['Order', '', '', '', 'Audit Log', '']],
        }),
      ),
    );
    expect(dslLines(dsl)).toEqual([
      'erDiagram',
      'title Orders',
      'direction LR',
      'Order {',
      'decimal(10,2) customer_id PK, FK',
      '}',
      'Audit_Log[Audit Log]',
      'Order ||--o{ Audit_Log : relates to',
    ]);
    const parsed = parseErd(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (isParseSuccess(parsed)) expect(parsed.model.nodes.find((n) => n.id === 'Order')!.attributes![0].keys).toEqual(['PK', 'FK']);
  });

  it('reports unknown entities, keys and cardinalities', () => {
    const base = { entities: [['Order']] };
    expect(errorsOf(erdTemplateCompiler.compile(fillTemplate(doc, { ...base, attributes: [['Invoice', 'id', 'string', '', '']] }))))
      .toEqual(['Section 3, attribute "Invoice.id": "Invoice" is not listed in Section 2 (Entities).']);
    expect(errorsOf(erdTemplateCompiler.compile(fillTemplate(doc, { ...base, attributes: [['Order', 'id', 'string', 'PRIMARY', '']] }))))
      .toEqual(['Section 3, attribute "Order.id": unrecognized Key "PRIMARY" (expected PK, FK or UK).']);
    expect(errorsOf(erdTemplateCompiler.compile(fillTemplate(doc, { ...base, relationships: [['Order', 'Lots', '', '', 'Order', '']] }))))
      .toEqual(['Section 4, "Order" -> "Order": cardinality must be one of Exactly one, Zero or one, One or more, Zero or more.']);
  });

  it('the blank template reports what is missing', () => {
    expect(errorsOf(erdTemplateCompiler.compile(doc))).toEqual(['Section 2: list at least one entity.']);
  });
});
