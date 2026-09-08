import { describe, expect, it } from 'vitest';
import { c4ContextTemplateCompiler } from '../../src/template/c4-context-template-compiler.js';
import { parseC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { TemplateCompileResult } from '../../src/template/types.js';

/**
 * Builds a filled-in copy of docs/c4-context-template.md's own section structure, so every test
 * exercises the compiler against realistic template text (real headings, real column names) not
 * a hand-shortened stand-in. Each section can be overridden per test; passing `null` omits that
 * section entirely (for the "missing required section" error cases).
 */

const TITLE_HEADING = '# C4 Context Diagram — Intake Template';

function tableSection(heading: string, headers: string[], rows: string[][]): string {
  const dataRows = rows.length > 0 ? rows : [headers.map(() => '')];
  const lines = [
    heading,
    '',
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...dataRows.map((row) => `| ${row.join(' | ')} |`),
    '',
  ];
  return lines.join('\n');
}

function metadataSection(
  opts: { title?: string; name?: string; description?: string; technology?: string } = {},
): string {
  const {
    title = '',
    name = 'OrderService',
    description = 'Handles order creation and fulfillment',
    technology = '',
  } = opts;
  return tableSection('## 1. Diagram metadata', ['Field', 'Value'], [
    ['Diagram title', title],
    ['Central system name', name],
    ['Central system description (one line)', description],
    ['Central system technology (optional)', technology],
  ]);
}

function boundariesSection(rows: string[][]): string {
  return tableSection('## 2. Boundaries (optional)', ['Boundary name', 'Type (Enterprise / System)', 'Entities inside'], rows);
}

function entitiesSection(rows: string[][]): string {
  return tableSection(
    '## 3. Surrounding entities',
    ['Name', 'Type', 'Internal/External', 'Description (one line)', 'Technology (optional)'],
    rows,
  );
}

function relationshipsSection(rows: string[][]): string {
  return tableSection(
    '## 4. Relationships',
    ['From', 'To', 'Label (short verb phrase)', 'Technology/protocol (optional)'],
    rows,
  );
}

function stylingSection(rows: string[][]): string {
  return tableSection('## 5. Styling notes (optional)', ['Entity name', 'Background color', 'Font color', 'Border color'], rows);
}

const CUSTOMER_ROW = ['Customer', 'Person', 'Internal', 'Places and tracks orders', ''];

function buildDoc(
  opts: {
    metadata?: string | null;
    boundaries?: string | null;
    entities?: string | null;
    relationships?: string | null;
    styling?: string | null;
  } = {},
): string {
  const {
    metadata = metadataSection(),
    boundaries = boundariesSection([]),
    entities = entitiesSection([CUSTOMER_ROW]),
    relationships = relationshipsSection([]),
    styling = stylingSection([]),
  } = opts;
  const parts = [TITLE_HEADING, metadata, boundaries, entities, relationships, styling].filter(
    (p): p is string => p !== null,
  );
  return parts.join('\n\n');
}

function compile(markdown: string): TemplateCompileResult {
  return c4ContextTemplateCompiler.compile(markdown);
}

function expectDsl(result: TemplateCompileResult): string {
  if (!('dsl' in result)) {
    throw new Error(`Expected a compiled DSL result, got errors: ${JSON.stringify('errors' in result ? result.errors : result)}`);
  }
  return result.dsl;
}

function expectErrors(result: TemplateCompileResult) {
  if (!('errors' in result)) {
    throw new Error(`Expected a compile error result, got dsl: ${JSON.stringify(result)}`);
  }
  return result.errors;
}

describe('c4ContextTemplateCompiler: golden path (docs/c4-context-template.md worked example)', () => {
  it('compiles the doc\'s own worked example into DSL that parseC4 accepts, with the right nodes/edges/title', () => {
    const doc = buildDoc({
      entities: entitiesSection([
        ['Customer', 'Person', 'Internal', 'Places and tracks orders', ''],
        ['Payment Gateway', 'System', 'External', 'Processes credit card payments', ''],
      ]),
      relationships: relationshipsSection([
        ['Customer', 'OrderService', 'Places orders using', 'HTTPS'],
        ['OrderService', 'Payment Gateway', 'Sends payment requests to', 'HTTPS/JSON'],
      ]),
    });

    const result = compile(doc);
    const dsl = expectDsl(result);

    // Matches the doc's own worked-example output exactly.
    expect(dsl).toContain('C4Context');
    expect(dsl).toContain('title System Context diagram: OrderService');
    expect(dsl).toContain('System(orderService, "OrderService", "Handles order creation and fulfillment")');
    expect(dsl).toContain('Person(customer, "Customer", "Places and tracks orders")');
    expect(dsl).toContain('System_Ext(paymentGateway, "Payment Gateway", "Processes credit card payments")');
    expect(dsl).toContain('Rel(customer, orderService, "Places orders using", "HTTPS")');
    expect(dsl).toContain('Rel(orderService, paymentGateway, "Sends payment requests to", "HTTPS/JSON")');

    const parsed = parseC4(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;

    expect(parsed.model.title).toBe('System Context diagram: OrderService');
    expect(parsed.model.nodes).toHaveLength(3);
    expect(parsed.model.edges).toHaveLength(2);

    const roleById = new Map(parsed.model.nodes.map((n) => [n.id, n.role]));
    expect(roleById.get('orderService')).toBe('system');
    expect(roleById.get('customer')).toBe('person');
    expect(roleById.get('paymentGateway')).toBe('system');

    const customerToOrder = parsed.model.edges.find((e) => e.sourceId === 'customer' && e.targetId === 'orderService');
    expect(customerToOrder?.label).toBe('Places orders using');
    const orderToGateway = parsed.model.edges.find((e) => e.sourceId === 'orderService' && e.targetId === 'paymentGateway');
    expect(orderToGateway?.label).toBe('Sends payment requests to');
  });
});

describe('c4ContextTemplateCompiler: boundary handling', () => {
  it('a filled Boundaries section nests the entity inside a boundary container, not duplicated as a top-level node', () => {
    const doc = buildDoc({
      boundaries: boundariesSection([['Internal Systems', 'System', 'Customer']]),
      entities: entitiesSection([CUSTOMER_ROW]),
    });

    const dsl = expectDsl(compile(doc));
    const parsed = parseC4(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;

    expect(parsed.model.containers).toHaveLength(1);
    const boundary = parsed.model.containers[0];
    expect(boundary.label).toBe('Internal Systems');

    const customerNodes = parsed.model.nodes.filter((n) => n.label === 'Customer');
    expect(customerNodes).toHaveLength(1);
    expect(customerNodes[0].containerId).toBe(boundary.id);
  });
});

describe('c4ContextTemplateCompiler: styling', () => {
  it('a filled Styling notes row produces node.style fields after reparse', () => {
    const doc = buildDoc({
      entities: entitiesSection([CUSTOMER_ROW]),
      styling: stylingSection([['Customer', '#ff0000', '#ffffff', '#00ff00']]),
    });

    const dsl = expectDsl(compile(doc));
    expect(dsl).toContain('UpdateElementStyle(customer,');

    const parsed = parseC4(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;

    const customer = parsed.model.nodes.find((n) => n.label === 'Customer')!;
    // Only bgColor/borderColor have a modeled NodeStyle equivalent (fontColor does not, matching
    // UpdateElementStyle's own established "textColor/fontColor has no modeled equivalent" pattern
    // in dsl/c4.ts) -- confirmed against the same real parser, not assumed.
    expect(customer.style?.fillColor).toBe('#ff0000');
    expect(customer.style?.strokeColor).toBe('#00ff00');
  });
});

describe('c4ContextTemplateCompiler: alias generation + collision', () => {
  it('two entities that slugify to the same alias get distinct suffixed ids, and both exist as separate nodes', () => {
    const doc = buildDoc({
      entities: entitiesSection([
        ['Payment Service', 'System', 'External', 'Handles payments variant A', ''],
        ['Payment-Service', 'System', 'External', 'Handles payments variant B', ''],
      ]),
    });

    const dsl = expectDsl(compile(doc));
    const parsed = parseC4(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;

    // Central (orderService) + 2 entities -- no silent merge of the colliding pair.
    expect(parsed.model.nodes).toHaveLength(3);
    const first = parsed.model.nodes.find((n) => n.id === 'paymentService');
    const second = parsed.model.nodes.find((n) => n.id === 'paymentService2');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
    expect(first?.label).toBe('Payment Service');
    expect(second?.label).toBe('Payment-Service');
  });
});

describe('c4ContextTemplateCompiler: _Ext suffix', () => {
  it('an External-scoped entity emits the _Ext keyword in the generated DSL, and still resolves the same role after reparse', () => {
    const doc = buildDoc({
      entities: entitiesSection([['Payment Gateway', 'System', 'External', 'Processes payments', '']]),
    });

    const dsl = expectDsl(compile(doc));
    expect(dsl).toContain('System_Ext(paymentGateway,');

    const parsed = parseC4(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    const entity = parsed.model.nodes.find((n) => n.id === 'paymentGateway')!;
    // _Ext collapses to the same role as its base kind (a known, disclosed limitation of C4's own
    // model -- no field distinguishes "external") -- this only confirms the DSL keyword itself.
    expect(entity.role).toBe('system');
  });

  it('an External-scoped Person entity emits Person_Ext', () => {
    const doc = buildDoc({
      entities: entitiesSection([['External Auditor', 'Person', 'External', 'Reviews compliance', '']]),
    });
    const dsl = expectDsl(compile(doc));
    expect(dsl).toContain('Person_Ext(externalAuditor,');
  });
});

describe('c4ContextTemplateCompiler: error cases', () => {
  it('reports an error when Section 1 (Diagram metadata) is missing entirely', () => {
    const doc = buildDoc({ metadata: null });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Missing required section "1. Diagram metadata".');
  });

  it('reports an error when Section 3 (Surrounding entities) is missing entirely', () => {
    const doc = buildDoc({ entities: null });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Missing required section "3. Surrounding entities".');
  });

  it('reports an error when Section 4 (Relationships) is missing entirely', () => {
    const doc = buildDoc({ relationships: null });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Missing required section "4. Relationships".');
  });

  it('reports an error when multiple required sections are missing at once (accumulated, not just the first)', () => {
    const doc = buildDoc({ metadata: null, relationships: null });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.message).join(' ')).toContain('Missing required section "1. Diagram metadata".');
    expect(errors.map((e) => e.message).join(' ')).toContain('Missing required section "4. Relationships".');
  });

  it('reports an error when "Central system name" is blank', () => {
    const doc = buildDoc({ metadata: metadataSection({ name: '' }) });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Section 1: "Central system name" is required.');
  });

  it('reports an error when "Central system description" is blank', () => {
    const doc = buildDoc({ metadata: metadataSection({ description: '' }) });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Section 1: "Central system description (one line)" is required.');
  });

  it('reports an error for an unrecognized Type value in an entity row', () => {
    const doc = buildDoc({
      entities: entitiesSection([['Widget Service', 'Actor', 'Internal', 'Does widget things', '']]),
    });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Section 3, entity "Widget Service": unrecognized Type "Actor"');
  });

  it('reports an error for an unrecognized Internal/External value', () => {
    const doc = buildDoc({
      entities: entitiesSection([['Widget Service', 'System', 'Maybe', 'Does widget things', '']]),
    });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Section 3, entity "Widget Service": unrecognized Internal/External value "Maybe"');
  });

  it('reports an error when a relationship references a name not in Section 3 and not the central system', () => {
    const doc = buildDoc({
      entities: entitiesSection([CUSTOMER_ROW]),
      relationships: relationshipsSection([['Someone Else', 'OrderService', 'Talks to', '']]),
    });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('relationship "From" value "Someone Else" is not the central system and not listed in Section 3.');
  });

  it('reports an error when a relationship\'s "To" references a name not in Section 3 and not the central system', () => {
    const doc = buildDoc({
      entities: entitiesSection([CUSTOMER_ROW]),
      relationships: relationshipsSection([['Customer', 'Nobody', 'Talks to', '']]),
    });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('relationship "To" value "Nobody" is not the central system and not listed in Section 3.');
  });

  it('reports the Level-1 "hub and spoke" violation when both sides of a relationship are surrounding entities', () => {
    const doc = buildDoc({
      entities: entitiesSection([
        ['Customer', 'Person', 'Internal', 'Places and tracks orders', ''],
        ['Payment Gateway', 'System', 'External', 'Processes credit card payments', ''],
      ]),
      relationships: relationshipsSection([['Customer', 'Payment Gateway', 'Talks to', '']]),
    });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('must connect the central system to exactly one surrounding entity (Level 1 rule)');
  });

  it('reports the same Level-1 violation (same check, same message shape) when neither side is the central system via a self-referential central-to-central row', () => {
    // The compiler's own check is a single `fromIsCentral === toIsCentral` condition -- it can't
    // distinguish "both sides are entities" from "central system referenced on both sides" (or
    // any other way to have neither/both count as central); this test documents that the two
    // scenarios really do collapse onto the identical error message, not two distinguishable ones.
    const doc = buildDoc({
      entities: entitiesSection([CUSTOMER_ROW]),
      relationships: relationshipsSection([['OrderService', 'OrderService', 'Talks to itself', '']]),
    });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('must connect the central system to exactly one surrounding entity (Level 1 rule)');
  });

  it('reports an error when a relationship is missing its Label', () => {
    const doc = buildDoc({
      entities: entitiesSection([CUSTOMER_ROW]),
      relationships: relationshipsSection([['Customer', 'OrderService', '', '']]),
    });
    const errors = expectErrors(compile(doc));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('relationship "Customer" -> "OrderService" is missing a Label.');
  });
});
