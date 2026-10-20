import { describe, expect, it } from 'vitest';
import { parseSequence } from '../../src/dsl/sequence.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { sequenceTemplateCompiler } from '../../src/template/sequence-template-compiler.js';
import { getTemplateCompiler } from '../../src/template/template-registry.js';
import type { TemplateCompileResult } from '../../src/template/types.js';
import { dslLines, exampleDsl, exampleTables, fillTemplate, readTemplateDoc } from '../fixtures/template-fill.js';

/** canvas-73s.1: docs/sequence-template.md -> Mermaid sequenceDiagram. */

const doc = readTemplateDoc('sequence-template.md');

const PEOPLE = [
  ['Customer', 'Actor'],
  ['Web Shop', 'Participant'],
  ['Payment Service', 'Participant'],
];

function compile(rows: Record<string, string[][] | null>): TemplateCompileResult {
  return sequenceTemplateCompiler.compile(fillTemplate(doc, { participants: PEOPLE, ...rows }));
}

function dslOf(result: TemplateCompileResult): string {
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.dsl;
}

function errorsOf(result: TemplateCompileResult): string[] {
  return 'errors' in result ? result.errors.map((e) => e.message) : [];
}

describe('sequence template compiler', () => {
  it('is registered for the sequence diagram type', () => {
    expect(getTemplateCompiler('sequence')).toBe(sequenceTemplateCompiler);
  });

  it("compiles the doc's own worked example to the DSL the doc shows, and that DSL parses", () => {
    const [participants, messages, blocks] = exampleTables(doc);
    const dsl = dslOf(sequenceTemplateCompiler.compile(fillTemplate(doc, { participants, messages, blocks })));
    expect(dslLines(dsl)).toEqual(dslLines(exampleDsl(doc)));
    const parsed = parseSequence(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
  });

  it('participants in order, actors vs participants, arrows and activation markers', () => {
    const dsl = dslOf(
      compile({
        messages: [
          ['1', 'Customer', 'Web Shop', 'Browse', 'Async', ''],
          ['2', 'Web Shop', 'Web Shop', 'Log visit', 'Sync', 'Start'],
          ['3', 'Web Shop', 'Payment Service', 'Ping', 'Lost', 'End'],
        ],
      }),
    );
    expect(dslLines(dsl).slice(1, 4)).toEqual(['actor customer as Customer', 'participant webShop as Web Shop', 'participant paymentService as Payment Service']);
    expect(dsl).toContain('customer -) webShop: Browse');
    expect(dsl).toContain('webShop ->>+ webShop: Log visit');
    expect(dsl).toContain('webShop -x- paymentService: Ping');
    const parsed = parseSequence(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
  });

  it('title and autonumber from the metadata', () => {
    const dsl = dslOf(
      compile({
        'diagram metadata': [
          ['Diagram title', 'Checkout'],
          ['Number the messages (Yes / No)', 'Yes'],
        ],
        messages: [['1', 'Customer', 'Web Shop', 'Hi', '', '']],
      }),
    );
    expect(dslLines(dsl).slice(0, 3)).toEqual(['sequenceDiagram', 'title Checkout', 'autonumber']);
  });

  it('nested blocks with branches and a note round-trip through the parser', () => {
    const dsl = dslOf(
      compile({
        messages: [
          ['1', 'Customer', 'Web Shop', 'Order', 'Sync', ''],
          ['2', 'Web Shop', 'Payment Service', 'Charge', 'Sync', ''],
          ['3', 'Payment Service', 'Web Shop', 'Retry', 'Reply', ''],
          ['4', 'Payment Service', 'Web Shop', 'OK', 'Reply', ''],
          ['5', 'Payment Service', 'Web Shop', 'Declined', 'Reply', ''],
        ],
        blocks: [
          ['Alt', 'Approved', '2', '5', '5: Declined'],
          ['Loop', 'Until settled', '2', '3', ''],
        ],
        notes: [['4', 'Over', 'Web Shop, Payment Service', 'Settled']],
      }),
    );
    expect(dslLines(dsl).slice(4)).toEqual([
      'customer ->> webShop: Order',
      'alt Approved',
      'loop Until settled',
      'webShop ->> paymentService: Charge',
      'paymentService -->> webShop: Retry',
      'end',
      'paymentService -->> webShop: OK',
      'Note over webShop,paymentService: Settled',
      'else Declined',
      'paymentService -->> webShop: Declined',
      'end',
    ]);
    const parsed = parseSequence(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    expect(parsed.model.containers.map((c) => c.role)).toEqual(expect.arrayContaining(['alt', 'loop', 'note-over', 'else']));
  });

  it('a branch can start where an inner block opens (the divider comes first)', () => {
    const dsl = dslOf(
      compile({
        messages: [
          ['1', 'Customer', 'Web Shop', 'A', '', ''],
          ['2', 'Customer', 'Web Shop', 'B', '', ''],
          ['3', 'Customer', 'Web Shop', 'C', '', ''],
        ],
        blocks: [
          ['Alt', 'X', '1', '3', '2: Y'],
          ['Opt', 'Z', '2', '3', ''],
        ],
      }),
    );
    expect(dslLines(dsl).slice(4)).toEqual(['alt X', 'customer ->> webShop: A', 'else Y', 'opt Z', 'customer ->> webShop: B', 'customer ->> webShop: C', 'end', 'end']);
    expect(isParseSuccess(parseSequence(dsl))).toBe(true);
  });

  it('reports unknown participants, bad arrows, partly-overlapping blocks and misplaced branches', () => {
    const messages = [
      ['1', 'Customer', 'Web Shop', 'A', '', ''],
      ['2', 'Customer', 'Web Shop', 'B', '', ''],
      ['3', 'Customer', 'Web Shop', 'C', '', ''],
    ];
    expect(errorsOf(compile({ messages: [['1', 'Customer', 'Warehouse', 'Hi', '', '']] }))[0]).toContain('"Warehouse" is not listed in Section 2');
    expect(errorsOf(compile({ messages: [['1', 'Customer', 'Web Shop', 'Hi', 'Teleport', '']] }))[0]).toContain('unrecognized Arrow "Teleport"');
    expect(errorsOf(compile({ messages, blocks: [['Loop', 'A', '1', '2', ''], ['Opt', 'B', '2', '3', '']] }))[0]).toContain('partly overlap');
    expect(errorsOf(compile({ messages, blocks: [['Alt', 'A', '1', '2', '3: Late']] }))[0]).toContain('branch "3: Late"');
    expect(errorsOf(compile({ messages, blocks: [['Loop', 'A', '1', '3', '2: Nope']] }))[0]).toContain('only Alt, Par and Critical');
    expect(errorsOf(compile({ messages, blocks: [['Alt', 'A', '1', '3', '3: Else'], ['Loop', 'B', '2', '3', '']] }))[0]).toContain('crosses a branch');
  });

  it('the blank template reports what is missing instead of producing a diagram', () => {
    const errors = errorsOf(sequenceTemplateCompiler.compile(doc));
    expect(errors).toEqual(['Section 2: list at least one participant.']);
  });

  it('missing required sections are reported', () => {
    expect(errorsOf(compile({ messages: null }))).toEqual(['Missing required section "3. Messages".']);
  });
});
