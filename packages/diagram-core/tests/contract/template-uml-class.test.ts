import { describe, expect, it } from 'vitest';
import { isParseSuccess } from '../../src/dsl/types.js';
import { parseUml } from '../../src/dsl/uml.js';
import { getTemplateCompiler } from '../../src/template/template-registry.js';
import type { TemplateCompileResult } from '../../src/template/types.js';
import { umlClassTemplateCompiler } from '../../src/template/uml-class-template-compiler.js';
import { dslLines, exampleDsl, exampleTables, fillTemplate, readTemplateDoc } from '../fixtures/template-fill.js';

/** canvas-73s.3: docs/uml-class-template.md -> Mermaid classDiagram. */

const doc = readTemplateDoc('uml-class-template.md');

function dslOf(result: TemplateCompileResult): string {
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.dsl;
}
const errorsOf = (result: TemplateCompileResult) => ('errors' in result ? result.errors.map((e) => e.message) : []);
const compile = (rows: Record<string, string[][] | null>) => umlClassTemplateCompiler.compile(fillTemplate(doc, rows));

describe('UML class template compiler', () => {
  it('is registered for the uml diagram type', () => {
    expect(getTemplateCompiler('uml')).toBe(umlClassTemplateCompiler);
  });

  it("compiles the doc's own worked example to the DSL the doc shows, and the model is right", () => {
    const [classes, members, relationships] = exampleTables(doc);
    const dsl = dslOf(compile({ classes, members, relationships }));
    expect(dslLines(dsl)).toEqual(dslLines(exampleDsl(doc)));

    const parsed = parseUml(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    const shape = parsed.model.nodes.find((n) => n.id === 'Shape')!;
    expect(shape.umlStereotype).toBe('interface');
    expect(shape.members).toEqual([expect.objectContaining({ name: 'area', kind: 'method', visibility: '+', returnType: 'double', isAbstract: true })]);
    const circle = parsed.model.nodes.find((n) => n.id === 'Circle')!;
    expect(circle.members!.map((m) => m.name)).toEqual(['radius', 'area', 'unit']);
    expect(parsed.model.edges[0]).toMatchObject({ sourceId: 'Circle', targetId: 'Shape', umlRelationKind: 'realization' });
  });

  it('generics, namespaces, inheritance (parent first), multiplicities and labels', () => {
    const dsl = dslOf(
      compile({
        classes: [
          ['Vehicle', '', 'Fleet'],
          ['Car', '', 'Fleet'],
          ['Repository<T>', '', ''],
          ['Garage', '', ''],
        ],
        members: [
          ['Repository', 'items', 'Attribute', 'Private', 'List<T>', '', ''],
          ['Repository', 'find', 'Method', 'Public', 'T', 'String id', ''],
        ],
        relationships: [
          ['Car', 'Inheritance', 'Vehicle', '', '', ''],
          ['Garage', 'Aggregation', 'Car', 'parks', '1', '*'],
        ],
      }),
    );
    expect(dslLines(dsl)).toEqual([
      'classDiagram',
      'class Repository~T~ {',
      '-List~T~ items',
      '+find(String id) T',
      '}',
      'class Garage',
      'namespace Fleet {',
      'class Vehicle',
      'class Car',
      '}',
      'Vehicle <|-- Car',
      'Garage "1" o-- "*" Car : parks',
    ]);
    const parsed = parseUml(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) return;
    expect(parsed.model.edges[0]).toMatchObject({ sourceId: 'Vehicle', targetId: 'Car', umlRelationKind: 'inheritance' });
    expect(parsed.model.edges[1]).toMatchObject({ umlRelationKind: 'aggregation', sourceCardinality: '1', targetCardinality: '*', label: 'parks' });
    expect(parsed.model.nodes.find((n) => n.id === 'Car')!.containerId).toBeDefined();
  });

  it('reports a class name that is not an identifier, an unknown class, and an unknown relationship', () => {
    expect(errorsOf(compile({ classes: [['Order Line', '', '']] }))[0]).toContain('a class name must be one word');
    expect(errorsOf(compile({ classes: [['Order', '', '']], members: [['Invoice', 'id', '', '', '', '', '']] }))).toEqual([
      'Section 3, member "Invoice.id": "Invoice" is not listed in Section 2 (Classes).',
    ]);
    expect(errorsOf(compile({ classes: [['A', '', ''], ['B', '', '']], relationships: [['A', 'Marries', 'B', '', '', '']] }))[0]).toContain(
      'unrecognized Relationship "Marries"',
    );
  });

  it('the blank template reports what is missing', () => {
    expect(errorsOf(umlClassTemplateCompiler.compile(doc))).toEqual(['Section 2: list at least one class.']);
  });
});
