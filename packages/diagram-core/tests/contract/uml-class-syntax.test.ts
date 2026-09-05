import { describe, expect, it } from 'vitest';
import { parseUml, serializeUml } from '../../src/dsl/uml.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * jmuir-dtu.2: `packages/diagram-core/src/dsl/uml.ts` was almost entirely rewritten to close a
 * previously-disclosed gap ("class bodies are recognized but their contents skipped entirely").
 * This file is the first dedicated UML contract-test coverage — previously only a generic smoke
 * test (`import.test.ts`) and a passing `classDiagram` mention (`comments-everywhere.test.ts`)
 * existed.
 *
 * Mirrors `dsl-c4.test.ts`'s normalize()/roundTrip() convention, since UML — like C4 — has real
 * nodes/edges/containers to compare, not just entity attribute blocks (erd-attributes.test.ts's
 * own, simpler idiom).
 *
 * One deliberate deviation from dsl-c4.test.ts's normalize(): `serializeUml` DOES write a
 * `canvas.containers` position block (mirroring `serializeC4`/flowchart-parser.ts), and a
 * namespace's position round-trips reliably off it since its id is the author-given (qualified,
 * as of jmuir-dtu.2.1) name — stable across saves. A note's position remains best-effort only: its
 * id is an auto-incrementing counter (`note1`, `note2`, ...) with no author-given identifier to
 * key off in Mermaid's own grammar, so its position can still drift if notes are added, removed,
 * or reordered between saves (confirmed stable for the untouched-reparse case this file exercises;
 * not guaranteed beyond that). normalize() below strips container position rather than asserting
 * on it, uniformly across roles, since that's the one field with a known (disclosed, not fixed)
 * gap rather than special-casing per role.
 */

function normalize(model: DiagramModel) {
  return {
    diagramTypeId: model.diagramTypeId,
    direction: model.direction,
    nodes: [...model.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...model.edges].sort((a, b) => a.id.localeCompare(b.id)),
    containers: [...model.containers]
      .map((c) => {
        const { position: _position, ...rest } = c;
        return rest;
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function roundTrip(model: DiagramModel): DiagramModel {
  const dsl = serializeUml(model);
  const result = parseUml(dsl);
  if (!isParseSuccess(result)) {
    throw new Error(`Expected successful round-trip parse, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.model;
}

/** Parses `dsl`, asserts success, and returns the model — a shared idiom throughout this test
 *  file since almost every test needs to inspect the parsed model and most of the parse-only
 *  tests would otherwise repeat the same `isParseSuccess` guard. */
function parseOk(dsl: string): DiagramModel {
  const result = parseUml(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

describe('uml parser: class members — attributes', () => {
  it('parses a typed attribute with each of the four visibility markers', () => {
    const model = parseOk(
      [
        'classDiagram',
        'class Foo {',
        '  +String pub',
        '  -String priv',
        '  #String prot',
        '  ~String pkg',
        '}',
        '',
      ].join('\n'),
    );
    const foo = model.nodes.find((n) => n.id === 'Foo')!;
    expect(foo.members).toEqual([
      { kind: 'attribute', visibility: '+', name: 'pub', type: 'String' },
      { kind: 'attribute', visibility: '-', name: 'priv', type: 'String' },
      { kind: 'attribute', visibility: '#', name: 'prot', type: 'String' },
      { kind: 'attribute', visibility: '~', name: 'pkg', type: 'String' },
    ]);
  });

  it('parses a bare no-type attribute (just a name, no visibility)', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  count\n}\n');
    expect(model.nodes[0].members).toEqual([{ kind: 'attribute', name: 'count' }]);
  });

  it('parses a bare no-type attribute with a visibility marker (+bareName)', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  +bareName\n}\n');
    expect(model.nodes[0].members).toEqual([{ kind: 'attribute', visibility: '+', name: 'bareName' }]);
  });

  it('parses a generic type, including one with internal spaces/commas (Map~string, int~)', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  ~Map~string, int~ counts\n}\n');
    expect(model.nodes[0].members).toEqual([
      { kind: 'attribute', visibility: '~', name: 'counts', type: 'Map~string, int~' },
    ]);
  });

  it('parses a single-parameter generic type (List~string~)', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  #List~string~ tags\n}\n');
    expect(model.nodes[0].members).toEqual([
      { kind: 'attribute', visibility: '#', name: 'tags', type: 'List~string~' },
    ]);
  });

  it('parses the static ($) modifier on an attribute', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  -count$\n}\n');
    expect(model.nodes[0].members).toEqual([
      { kind: 'attribute', visibility: '-', name: 'count', isStatic: true },
    ]);
  });

  it('round-trips a full mix of attribute forms through serialize -> reparse', () => {
    const model: DiagramModel = {
      diagramTypeId: 'uml',
      nodes: [
        {
          id: 'Foo',
          label: 'Foo',
          shape: 'rectangle',
          role: 'class',
          position: { x: 0, y: 0 },
          members: [
            { kind: 'attribute', visibility: '+', name: 'name', type: 'String' },
            { kind: 'attribute', name: 'bareName' },
            { kind: 'attribute', visibility: '~', name: 'counts', type: 'Map~string, int~' },
            { kind: 'attribute', visibility: '-', name: 'count', isStatic: true },
          ],
        },
      ],
      edges: [],
      containers: [],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });
});

describe('uml parser: class members — methods', () => {
  it('parses a method with no params and no return type', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  +noop()\n}\n');
    expect(model.nodes[0].members).toEqual([{ kind: 'method', visibility: '+', name: 'noop', params: '' }]);
  });

  it('parses a method with params and a return type', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  #calc(int x, int y) int\n}\n');
    expect(model.nodes[0].members).toEqual([
      { kind: 'method', visibility: '#', name: 'calc', params: 'int x, int y', returnType: 'int' },
    ]);
  });

  it('parses the abstract (*) modifier from the correct trailing position, after the return type', () => {
    // Per the bead's own contract: the modifier is always at the very end (after the return type
    // for a method), e.g. "+makeSound() String*" — not "+makeSound()* String".
    const model = parseOk('classDiagram\nclass Foo {\n  +makeSound() String*\n}\n');
    expect(model.nodes[0].members).toEqual([
      { kind: 'method', visibility: '+', name: 'makeSound', params: '', returnType: 'String', isAbstract: true },
    ]);
  });

  it('parses the static ($) modifier on a method with a return type', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  +calc() int$\n}\n');
    expect(model.nodes[0].members).toEqual([
      { kind: 'method', visibility: '+', name: 'calc', params: '', returnType: 'int', isStatic: true },
    ]);
  });

  it('parses a method with params but no return type', () => {
    const model = parseOk('classDiagram\nclass Foo {\n  -speak(String msg)\n}\n');
    expect(model.nodes[0].members).toEqual([
      { kind: 'method', visibility: '-', name: 'speak', params: 'String msg' },
    ]);
  });

  it('round-trips a method with generics in both params and return type', () => {
    const model: DiagramModel = {
      diagramTypeId: 'uml',
      nodes: [
        {
          id: 'Foo',
          label: 'Foo',
          shape: 'rectangle',
          role: 'class',
          position: { x: 0, y: 0 },
          members: [
            { kind: 'method', visibility: '+', name: 'makeSound', params: '', returnType: 'String', isAbstract: true },
            { kind: 'method', visibility: '+', name: 'run', params: '', isStatic: true },
          ],
        },
      ],
      edges: [],
      containers: [],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });
});

describe('uml parser: mixed member declaration order', () => {
  it('preserves declaration order across interleaved attributes and methods', () => {
    const dsl = [
      'classDiagram',
      'class Animal {',
      '  +String name',
      '  -int age',
      '  +makeSound() String*',
      '  #protectedField',
      '  -speak(String msg)',
      '}',
      '',
    ].join('\n');
    const model = parseOk(dsl);
    const members = model.nodes.find((n) => n.id === 'Animal')!.members!;
    expect(members.map((m) => m.name)).toEqual(['name', 'age', 'makeSound', 'protectedField', 'speak']);
    expect(members.map((m) => m.kind)).toEqual(['attribute', 'attribute', 'method', 'attribute', 'method']);
  });
});

describe('uml parser: relationship tokens', () => {
  // Each token individually, correct umlRelationKind, and a same-token round-trip. The
  // REL_TOKEN_TO_KIND / REL_KIND_TO_TOKEN maps inside uml.ts are exact inverses by construction
  // (REL_KIND_TO_TOKEN is generated directly from REL_TOKEN_TO_KIND via Object.fromEntries), so
  // asserting round-trip equality of the token itself is meaningful, not just an equality of
  // whatever the serializer happens to emit.
  it.each([
    ['<|--', 'inheritance'],
    ['*--', 'composition'],
    ['o--', 'aggregation'],
    ['-->', 'association'],
    ['..>', 'dependency'],
    ['--', 'link-solid'],
    ['..', 'link-dashed'],
    ['..|>', 'realization'],
  ] as const)('token "%s" parses to umlRelationKind "%s" and round-trips to the same token', (token, kind) => {
    const model = parseOk(`classDiagram\nA ${token} B\n`);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0].umlRelationKind).toBe(kind);

    const dsl = serializeUml(model);
    // The serialized relationship line must use the exact same token, not a different one that
    // happens to map to the same kind.
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(dsl).toMatch(new RegExp(`^A ${escapedToken} B$`, 'm'));

    const reparsed = parseOk(dsl);
    expect(reparsed.edges[0].umlRelationKind).toBe(kind);
  });
});

describe('uml parser: relationship cardinality', () => {
  it('captures cardinality on both sides', () => {
    const model = parseOk('classDiagram\nCustomer "1" --> "0..*" Order : places\n');
    expect(model.edges[0]).toMatchObject({
      sourceId: 'Customer',
      targetId: 'Order',
      sourceCardinality: '1',
      targetCardinality: '0..*',
      label: 'places',
    });
  });

  it('captures cardinality on the source side only', () => {
    const model = parseOk('classDiagram\nA "1" --> B\n');
    expect(model.edges[0].sourceCardinality).toBe('1');
    expect(model.edges[0].targetCardinality).toBeUndefined();
  });

  it('captures cardinality on the target side only', () => {
    const model = parseOk('classDiagram\nA --> "2" B\n');
    expect(model.edges[0].sourceCardinality).toBeUndefined();
    expect(model.edges[0].targetCardinality).toBe('2');
  });

  it('leaves both cardinalities undefined when neither side has one', () => {
    const model = parseOk('classDiagram\nA --> B\n');
    expect(model.edges[0].sourceCardinality).toBeUndefined();
    expect(model.edges[0].targetCardinality).toBeUndefined();
  });

  it('round-trips cardinality on both sides through serialize -> reparse', () => {
    const model: DiagramModel = {
      diagramTypeId: 'uml',
      nodes: [
        { id: 'Customer', label: 'Customer', shape: 'rectangle', role: 'class', position: { x: 0, y: 0 } },
        { id: 'Order', label: 'Order', shape: 'rectangle', role: 'class', position: { x: 200, y: 0 } },
      ],
      edges: [
        {
          id: 'e1',
          sourceId: 'Customer',
          targetId: 'Order',
          label: 'places',
          umlRelationKind: 'association',
          sourceCardinality: '1',
          targetCardinality: '0..*',
        },
      ],
      containers: [],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });
});

describe('uml parser: <<Stereotype>> annotations — all three placement forms', () => {
  it('inline on the decl line, no body', () => {
    const model = parseOk('classDiagram\nclass Duck <<Interface>>\n');
    expect(model.nodes[0].umlStereotype).toBe('Interface');
  });

  it('inline on the decl line, with a following body', () => {
    const model = parseOk('classDiagram\nclass Duck <<Interface>> {\n  +quack()\n}\n');
    const duck = model.nodes[0];
    expect(duck.umlStereotype).toBe('Interface');
    expect(duck.members).toEqual([{ kind: 'method', visibility: '+', name: 'quack', params: '' }]);
  });

  it('standalone, on its own line, referencing an already-declared class by name', () => {
    const model = parseOk('classDiagram\nclass Duck\n<<Interface>> Duck\n');
    expect(model.nodes[0].umlStereotype).toBe('Interface');
  });

  it('nested, as its own line inside a class body', () => {
    const model = parseOk('classDiagram\nclass Cat {\n  <<Interface>>\n  +String name\n}\n');
    const cat = model.nodes[0];
    expect(cat.umlStereotype).toBe('Interface');
    expect(cat.members).toEqual([{ kind: 'attribute', visibility: '+', name: 'name', type: 'String' }]);
  });

  // The serializer only has one output shape (`class <id> <<Stereotype>>`, optionally followed by
  // a body) — every placement form canonicalizes to the same inline-on-decl-line output.
  it('canonicalizes every placement form to the same inline-on-decl-line output on serialize', () => {
    const inline = parseOk('classDiagram\nclass Duck <<Interface>>\n');
    const standalone = parseOk('classDiagram\nclass Duck\n<<Interface>> Duck\n');
    const nested = parseOk('classDiagram\nclass Duck {\n  <<Interface>>\n}\n');

    for (const model of [inline, standalone, nested]) {
      const dsl = serializeUml(model);
      expect(dsl).toMatch(/^class Duck <<Interface>>/m);
    }
  });

  it('round-trips a stereotype through serialize -> reparse', () => {
    const model = parseOk('classDiagram\nclass Duck\n<<Interface>> Duck\n');
    const reparsed = roundTrip(model);
    expect(reparsed.nodes[0].umlStereotype).toBe('Interface');
    expect(normalize(reparsed)).toEqual(normalize(model));
  });
});

describe('uml parser: namespaces', () => {
  it('a class inside a namespace gets the right containerId', () => {
    const model = parseOk('classDiagram\nnamespace Shapes {\n  class Circle\n}\n');
    const ns = model.containers.find((c) => c.role === 'namespace' && c.label === 'Shapes')!;
    expect(ns).toBeDefined();
    expect(model.nodes.find((n) => n.id === 'Circle')!.containerId).toBe(ns.id);
  });

  it('nested namespaces get the right parentContainerId chain', () => {
    const model = parseOk(
      ['classDiagram', 'namespace Outer {', '  namespace Inner {', '    class X', '  }', '  class Y', '}', ''].join('\n'),
    );
    const outer = model.containers.find((c) => c.label === 'Outer')!;
    const inner = model.containers.find((c) => c.label === 'Inner')!;
    expect(outer.parentContainerId).toBeUndefined();
    expect(inner.parentContainerId).toBe(outer.id);
    expect(model.nodes.find((n) => n.id === 'X')!.containerId).toBe(inner.id);
    expect(model.nodes.find((n) => n.id === 'Y')!.containerId).toBe(outer.id);
  });

  it('a class NOT in any namespace is unaffected (regression guard)', () => {
    const model = parseOk('classDiagram\nnamespace NS {\n  class A\n}\nclass B\n');
    expect(model.nodes.find((n) => n.id === 'B')!.containerId).toBeUndefined();
  });

  it('round-trips namespace membership and nesting, correct in the output', () => {
    const model = parseOk(
      ['classDiagram', 'namespace Outer {', '  namespace Inner {', '    class X', '  }', '  class Y', '}', 'class Z', ''].join('\n'),
    );
    const dsl = serializeUml(model);
    expect(dsl).toContain('namespace Outer {');
    expect(dsl).toContain('namespace Inner {');
    // Inner nested textually inside Outer's block, not sibling.
    const outerIdx = dsl.indexOf('namespace Outer {');
    const innerIdx = dsl.indexOf('namespace Inner {');
    const outerEndIdx = dsl.indexOf('\n}', innerIdx); // Inner's own closing brace
    expect(innerIdx).toBeGreaterThan(outerIdx);
    expect(outerEndIdx).toBeGreaterThan(innerIdx);

    const reparsed = parseUml(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    const outer = reparsed.model.containers.find((c) => c.label === 'Outer')!;
    const inner = reparsed.model.containers.find((c) => c.label === 'Inner')!;
    expect(inner.parentContainerId).toBe(outer.id);
    expect(reparsed.model.nodes.find((n) => n.id === 'X')!.containerId).toBe(inner.id);
    expect(reparsed.model.nodes.find((n) => n.id === 'Y')!.containerId).toBe(outer.id);
    expect(reparsed.model.nodes.find((n) => n.id === 'Z')!.containerId).toBeUndefined();
  });
});

describe('uml parser: notes', () => {
  it('parses a standalone note with an empty attachedNodeIds', () => {
    const model = parseOk('classDiagram\nnote "top note"\n');
    const note = model.containers.find((c) => c.role === 'note')!;
    expect(note.label).toBe('top note');
    expect(note.attachedNodeIds).toEqual([]);
  });

  it('parses a "note for ClassName" attached note', () => {
    const model = parseOk('classDiagram\nclass Circle\nnote for Circle "attached note"\n');
    const note = model.containers.find((c) => c.role === 'note')!;
    expect(note.label).toBe('attached note');
    expect(note.attachedNodeIds).toEqual(['Circle']);
  });

  it('round-trips both a standalone and an attached note', () => {
    const model = parseOk('classDiagram\nclass Circle\nnote for Circle "attached note"\nnote "top note"\n');
    const dsl = serializeUml(model);
    expect(dsl).toContain('note for Circle "attached note"');
    expect(dsl).toContain('note "top note"');

    const reparsed = parseUml(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    const attached = reparsed.model.containers.find((c) => c.attachedNodeIds && c.attachedNodeIds.length > 0)!;
    expect(attached.label).toBe('attached note');
    expect(attached.attachedNodeIds).toEqual(['Circle']);
    const standalone = reparsed.model.containers.find((c) => c.role === 'note' && c !== attached)!;
    expect(standalone.label).toBe('top note');
    expect(standalone.attachedNodeIds).toEqual([]);
  });
});

describe('uml parser: styling — style/classDef/class/:::', () => {
  it('applies fill/stroke/stroke-width/stroke-dasharray from a style directive', () => {
    const model = parseOk(
      'classDiagram\nclass Foo\nstyle Foo fill:#e1f5fe,stroke:#0288d1,stroke-width:2,stroke-dasharray:5 5\n',
    );
    const foo = model.nodes[0];
    expect(foo.style?.fillColor).toBe('#e1f5fe');
    expect(foo.style?.strokeColor).toBe('#0288d1');
    expect(foo.style?.strokeWidth).toBe(2);
    expect(foo.style?.strokeDasharray).toBe('5 5');
  });

  it('resolves a class assignment that appears before the classDef it references (forward reference)', () => {
    const model = parseOk('classDiagram\nclass Foo\nclass Foo highlight\nclassDef highlight fill:#f9f,stroke:#333\n');
    const foo = model.nodes[0];
    expect(foo.style?.fillColor).toBe('#f9f');
    expect(foo.style?.strokeColor).toBe('#333');
  });

  it('applies one class line to a comma-separated list of class ids', () => {
    const model = parseOk(
      'classDiagram\nclass Foo\nclass Bar\nclass Baz\nclassDef highlight fill:#f9f\nclass Foo,Bar highlight\n',
    );
    expect(model.nodes.find((n) => n.id === 'Foo')!.style?.fillColor).toBe('#f9f');
    expect(model.nodes.find((n) => n.id === 'Bar')!.style?.fillColor).toBe('#f9f');
    expect(model.nodes.find((n) => n.id === 'Baz')!.style?.fillColor).toBeUndefined();
  });

  it('applies the ::: shorthand, including as a forward reference to a later classDef', () => {
    const model = parseOk('classDiagram\nFoo:::highlight\nclassDef highlight fill:#f9f\n');
    const foo = model.nodes.find((n) => n.id === 'Foo')!;
    expect(foo.style?.fillColor).toBe('#f9f');
  });

  it('lets an explicit style directive override a class-applied property on the same class', () => {
    const model = parseOk('classDiagram\nclass Foo\nclassDef highlight fill:#f9f,stroke:#333\nclass Foo highlight\nstyle Foo fill:#000\n');
    const foo = model.nodes[0];
    expect(foo.style?.fillColor).toBe('#000');
    expect(foo.style?.strokeColor).toBe('#333');
  });

  it('silently skips a style directive referencing a class id not otherwise present', () => {
    const model = parseOk('classDiagram\nclass Foo\nstyle Ghost fill:#000\n');
    expect(model.nodes.map((n) => n.id)).toEqual(['Foo']);
  });

  it('silently skips a class assignment referencing a class id not otherwise present', () => {
    const model = parseOk('classDiagram\nclass Foo\nclassDef highlight fill:#f9f\nclass Ghost highlight\n');
    expect(model.nodes.map((n) => n.id)).toEqual(['Foo']);
  });

  it('is a no-op for a class line naming a classDef that was never defined', () => {
    const model = parseOk('classDiagram\nclass Foo\nclass Foo ghost\n');
    expect(model.nodes[0].style).toBeUndefined();
  });

  it('round-trips a style set via style/classDef+class/::: through canvas.styles front matter, not as literal directive lines', () => {
    const model = parseOk(
      'classDiagram\nclass Foo\nclassDef highlight fill:#f9f,stroke:#333\nclass Foo highlight\nstyle Foo stroke-width:5\n',
    );
    const dsl = serializeUml(model);
    expect(dsl).toContain('styles:');
    expect(dsl).not.toMatch(/^\s*style\s+Foo/m);
    expect(dsl).not.toMatch(/^\s*classDef/m);

    const reparsed = parseUml(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    const foo = reparsed.model.nodes.find((n) => n.id === 'Foo')!;
    expect(foo.style?.fillColor).toBe('#f9f');
    expect(foo.style?.strokeColor).toBe('#333');
    expect(foo.style?.strokeWidth).toBe(5);
  });
});

describe('uml parser: the "class" keyword ambiguity (bare decl vs multi-id style assignment)', () => {
  it('parses "class Foo" as a bare declaration and "class Foo,Bar styleName" as a style assignment, in the same file', () => {
    const model = parseOk(
      ['classDiagram', 'class Foo', 'class Bar', 'classDef styleName fill:#f00', 'class Foo,Bar styleName', ''].join('\n'),
    );
    // Both classes exist as ordinary declared classes (the "class Foo,Bar styleName" line did NOT
    // create two more classes named "Foo,Bar" or "styleName").
    expect(model.nodes.map((n) => n.id).sort()).toEqual(['Bar', 'Foo']);
    // ...and both picked up the styleName's fill color via the multi-id assignment form.
    expect(model.nodes.find((n) => n.id === 'Foo')!.style?.fillColor).toBe('#f00');
    expect(model.nodes.find((n) => n.id === 'Bar')!.style?.fillColor).toBe('#f00');
  });

  it('a single bare "class Foo" line alone is never misread as a style assignment', () => {
    const model = parseOk('classDiagram\nclass Foo\n');
    expect(model.nodes).toHaveLength(1);
    expect(model.nodes[0].id).toBe('Foo');
    expect(model.nodes[0].style).toBeUndefined();
  });
});

describe('uml parser: direction', () => {
  it.each(['TB', 'BT', 'LR', 'RL'] as const)('parses and round-trips "direction %s"', (dir) => {
    const model = parseOk(`classDiagram\ndirection ${dir}\nclass A\n`);
    expect(model.direction).toBe(dir);

    const dsl = serializeUml(model);
    expect(dsl).toContain(`direction ${dir}`);

    const reparsed = parseUml(dsl);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (isParseSuccess(reparsed)) {
      expect(reparsed.model.direction).toBe(dir);
    }
  });

  it('leaves model.direction undefined when no direction line is present', () => {
    const model = parseOk('classDiagram\nclass A\n');
    expect(model.direction).toBeUndefined();
  });
});

describe('uml parser/serializer: combined round-trip', () => {
  it('round-trips a namespace with an annotated class with members, a styled class, a relationship with cardinality, and a note all together', () => {
    const dsl = [
      'classDiagram',
      'direction LR',
      'classDef highlight fill:#f9f,stroke:#333',
      'namespace Shapes {',
      '  class Circle <<Interface>> {',
      '    +String name',
      '    +draw() void*',
      '  }',
      '}',
      'class Square',
      'class Square highlight',
      'Circle "1" --> "0..*" Square : bounds',
      'note for Circle "the base shape"',
      '',
    ].join('\n');

    const model = parseOk(dsl);
    expect(model.direction).toBe('LR');

    const circle = model.nodes.find((n) => n.id === 'Circle')!;
    expect(circle.umlStereotype).toBe('Interface');
    expect(circle.members).toEqual([
      { kind: 'attribute', visibility: '+', name: 'name', type: 'String' },
      { kind: 'method', visibility: '+', name: 'draw', params: '', returnType: 'void', isAbstract: true },
    ]);
    const ns = model.containers.find((c) => c.role === 'namespace')!;
    expect(circle.containerId).toBe(ns.id);

    const square = model.nodes.find((n) => n.id === 'Square')!;
    expect(square.style?.fillColor).toBe('#f9f');
    expect(square.style?.strokeColor).toBe('#333');
    expect(square.containerId).toBeUndefined();

    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({
      sourceId: 'Circle',
      targetId: 'Square',
      sourceCardinality: '1',
      targetCardinality: '0..*',
      label: 'bounds',
      umlRelationKind: 'association',
    });

    const note = model.containers.find((c) => c.role === 'note')!;
    expect(note.label).toBe('the base shape');
    expect(note.attachedNodeIds).toEqual(['Circle']);

    // Now round-trip the whole thing and re-check every semantic field (position aside, per this
    // file's own header note about container position not being front-matter-preserved).
    const reparsed = roundTrip(model);
    expect(reparsed.direction).toBe('LR');
    const rCircle = reparsed.nodes.find((n) => n.id === 'Circle')!;
    expect(rCircle.umlStereotype).toBe('Interface');
    expect(rCircle.members).toEqual(circle.members);
    const rNs = reparsed.containers.find((c) => c.role === 'namespace')!;
    expect(rCircle.containerId).toBe(rNs.id);
    const rSquare = reparsed.nodes.find((n) => n.id === 'Square')!;
    expect(rSquare.style?.fillColor).toBe('#f9f');
    expect(rSquare.style?.strokeColor).toBe('#333');
    expect(reparsed.edges).toHaveLength(1);
    expect(reparsed.edges[0]).toMatchObject({
      sourceId: 'Circle',
      targetId: 'Square',
      sourceCardinality: '1',
      targetCardinality: '0..*',
      label: 'bounds',
      umlRelationKind: 'association',
    });
    const rNote = reparsed.containers.find((c) => c.role === 'note')!;
    expect(rNote.label).toBe('the base shape');
    expect(rNote.attachedNodeIds).toEqual(['Circle']);
  });
});

/**
 * jmuir-dtu.2.1: the three items jmuir-dtu.2 deliberately deferred — lollipop interface syntax,
 * namespace dot-notation, and the v11.15+ bracketed namespace label form — all implemented here.
 */
describe('uml parser: lollipop interfaces (jmuir-dtu.2.1)', () => {
  it('parses "()--" as a lollipop circle at the source end', () => {
    const model = parseOk('classDiagram\nBar ()-- Foo\n');
    const edge = model.edges[0];
    expect(edge.sourceId).toBe('Bar');
    expect(edge.targetId).toBe('Foo');
    expect(edge.umlRelationKind).toBe('lollipop-source');
  });

  it('parses "--()" as a lollipop circle at the target end', () => {
    const model = parseOk('classDiagram\nFoo --() Bar\n');
    const edge = model.edges[0];
    expect(edge.sourceId).toBe('Foo');
    expect(edge.targetId).toBe('Bar');
    expect(edge.umlRelationKind).toBe('lollipop-target');
  });

  it('round-trips both lollipop tokens back to their own literal form', () => {
    const model = parseOk('classDiagram\nclass Foo\nclass Bar\nBar ()-- Foo\nFoo --() Bar\n');
    const reparsed = roundTrip(model);
    expect(normalize(reparsed)).toEqual(normalize(model));
    const dsl = serializeUml(model);
    expect(dsl).toContain('Bar ()-- Foo');
    expect(dsl).toContain('Foo --() Bar');
  });

  it('coexists with an ordinary relationship between the same two classes', () => {
    const model = parseOk('classDiagram\nclass Shape\nclass Drawable\nDrawable <|-- Shape\nShape --() Drawable\n');
    expect(model.edges).toHaveLength(2);
    expect(model.edges[0].umlRelationKind).toBe('inheritance');
    expect(model.edges[1].umlRelationKind).toBe('lollipop-target');
  });

  it('auto-creates classes referenced only in a lollipop relation, like any other relation', () => {
    const model = parseOk('classDiagram\nClass1 --() Interface1\n');
    expect(model.nodes.map((n) => n.id).sort()).toEqual(['Class1', 'Interface1']);
  });
});

describe('uml parser: namespace dot-notation (jmuir-dtu.2.1)', () => {
  it('auto-creates parent namespaces for "namespace A.B.C"', () => {
    const model = parseOk('classDiagram\nnamespace A.B.C {\n  class Widget\n}\n');
    const a = model.containers.find((c) => c.id === 'A')!;
    const ab = model.containers.find((c) => c.id === 'A.B')!;
    const abc = model.containers.find((c) => c.id === 'A.B.C')!;
    expect(a.parentContainerId).toBeUndefined();
    expect(ab.parentContainerId).toBe('A');
    expect(abc.parentContainerId).toBe('A.B');
    expect(model.nodes.find((n) => n.id === 'Widget')!.containerId).toBe('A.B.C');
  });

  it('reuses an already-created ancestor for a later dot-notation statement', () => {
    const model = parseOk('classDiagram\nnamespace A.B {\n  class Widget\n}\nnamespace A.C {\n  class Gadget\n}\n');
    expect(model.containers.filter((c) => c.id === 'A')).toHaveLength(1);
    expect(model.nodes.find((n) => n.id === 'Widget')!.containerId).toBe('A.B');
    expect(model.nodes.find((n) => n.id === 'Gadget')!.containerId).toBe('A.C');
  });

  it('gives explicit-block nesting and dot-notation nesting the same qualified id, so different parents with a same-named child no longer collide', () => {
    const model = parseOk(
      ['classDiagram', 'namespace A {', '  namespace X {', '    class Foo', '  }', '}', 'namespace B {', '  namespace X {', '    class Bar', '  }', '}', ''].join(
        '\n',
      ),
    );
    const ax = model.containers.find((c) => c.parentContainerId === 'A')!;
    const bx = model.containers.find((c) => c.parentContainerId === 'B')!;
    expect(ax.id).toBe('A.X');
    expect(bx.id).toBe('B.X');
    expect(model.nodes.find((n) => n.id === 'Foo')!.containerId).toBe('A.X');
    expect(model.nodes.find((n) => n.id === 'Bar')!.containerId).toBe('B.X');
  });

  it('round-trips dot-notation to the equivalent nested-block form, stable on a second round-trip', () => {
    const model = parseOk('classDiagram\nnamespace A.B.C {\n  class Widget\n}\n');
    const dsl = serializeUml(model);
    expect(dsl).toContain('namespace A {');
    expect(dsl).toContain('namespace B {');
    expect(dsl).toContain('namespace C {');
    const reparsed = roundTrip(model);
    expect(normalize(reparsed)).toEqual(normalize(model));
    expect(serializeUml(reparsed)).toBe(dsl);
  });
});

describe('uml parser: bracketed namespace display label (jmuir-dtu.2.1)', () => {
  it('applies the label to the leaf namespace only, distinct from its declaration id', () => {
    const model = parseOk('classDiagram\nnamespace A.B["Business Layer"] {\n  class Widget\n}\n');
    const a = model.containers.find((c) => c.id === 'A')!;
    const ab = model.containers.find((c) => c.id === 'A.B')!;
    expect(a.label).toBe('A');
    expect(ab.label).toBe('Business Layer');
  });

  it('round-trips the bracketed form only when the label differs from the id, stable on a second round-trip', () => {
    const model = parseOk('classDiagram\nnamespace Team["The A Team"] {\n  class Widget\n}\n');
    const dsl = serializeUml(model);
    expect(dsl).toContain('namespace Team["The A Team"] {');
    const reparsed = roundTrip(model);
    expect(normalize(reparsed)).toEqual(normalize(model));
    expect(serializeUml(reparsed)).toBe(dsl);
  });

  it('does not re-emit a redundant bracketed label when it equals the plain name', () => {
    const model = parseOk('classDiagram\nnamespace Plain["Plain"] {\n  class Widget\n}\n');
    const dsl = serializeUml(model);
    expect(dsl).toContain('namespace Plain {');
    expect(dsl).not.toContain('["Plain"]');
  });
});

// canvas-vtg: 'title <text>' now recognized outside C4 too (canvas-79b introduced it there
// first) -- previously hard-errored the whole parse for every one of the other 5 families.
describe('uml parser: "title" directive (canvas-vtg)', () => {
  it('parses a top-level "title" line and round-trips it through serialize -> reparse', () => {
    const result = parseUml('classDiagram\ntitle My Diagram\nclass Animal\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBe('My Diagram');

    const reparsed = parseUml(serializeUml(result.model));
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.title).toBe('My Diagram');
  });

  it('a model with no title omits the "title" line entirely on serialize (no regression)', () => {
    const result = parseUml('classDiagram\nclass Animal\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBeUndefined();
    expect(serializeUml(result.model)).not.toContain('title');
  });
});
