import { describe, expect, it } from 'vitest';
import { toPortableMermaid } from '../../src/dsl/portable-mermaid.js';
import { DEFAULT_RELATIONSHIP_LABEL, parseErd, serializeErd } from '../../src/dsl/erd.js';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { parseUml, serializeUml } from '../../src/dsl/uml.js';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';

/**
 * canvas-0t84 part 2: Canvas reads (and writes back) forms real Mermaid refuses, so exported .mmd files did not
 * draw. The export rewrites them; text that parses is always written again in Canvas's form.
 */

const C4 = (body: string): string => `C4Container\n  title T\n${body}`;

describe('portable C4 export', () => {
  const BASE = C4('  Person(u, "User")\n  System(s, "S")\n  Rel_U(u, s, "uses")\n');

  it('writes text without Lay_ hints or empty boundaries as the C4 serializer does, and a second export is stable (Rel_U stays)', () => {
    const parsed = parseC4(BASE);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) throw new Error('unreachable');
    const out = toPortableMermaid(BASE);
    expect(out).toBe(serializeC4(parsed.model));
    expect(out).toContain('Rel_U(u, s, "uses")');
    expect(toPortableMermaid(out)).toBe(out);
  });

  it('drops Lay_U/D/L/R lines but keeps Rel_ direction hints', () => {
    const dsl = `${BASE}  Lay_U(u, s)\n  Lay_D(s, u)\n  Lay_L(u, s)\n  Lay_R(s, u)\n`;
    const out = toPortableMermaid(dsl);
    expect(out).not.toMatch(/Lay_/);
    expect(out).toContain('Rel_U(u, s, "uses")');
    expect(out).toContain('Person(u, "User")');
  });

  it('drops an empty boundary', () => {
    const dsl = C4('  Person(u, "User")\n  System_Boundary(b, "Empty") {\n  }\n');
    const out = toPortableMermaid(dsl);
    expect(out).not.toContain('System_Boundary');
    expect(out).toContain('Person(u, "User")');
  });

  it('drops a boundary whose only child was an empty boundary, repeatedly', () => {
    const dsl = C4(
      '  Person(u, "User")\n  Enterprise_Boundary(o, "Outer") {\n    System_Boundary(i, "Inner") {\n    }\n  }\n',
    );
    const out = toPortableMermaid(dsl);
    expect(out).not.toContain('Boundary');
    expect(out).toContain('Person(u, "User")');
  });

  it('keeps a boundary that holds an element', () => {
    const dsl = C4('  System_Boundary(b, "B") {\n    Container(c, "C")\n  }\n');
    const out = toPortableMermaid(dsl);
    expect(out).toContain('System_Boundary(b, "B")');
    expect(out).toContain('Container(c, "C")');
    expect(toPortableMermaid(out)).toBe(out);
  });

  it('writes no YAML anchors for a fresh import whose elements keep the placeholder position', () => {
    const dsl = C4('  Person(u, "User")\n  System(s, "S")\n  Container(c, "C")\n  Lay_R(u, s)\n');
    const out = toPortableMermaid(dsl);
    expect(out).not.toMatch(/&a\d|\*a\d/);
    expect(out).not.toMatch(/Lay_/);
  });
});

describe('portable ER export', () => {
  it('writes a diagram with no relationships and no aliases as the ER serializer does, entity and attribute kept', () => {
    const dsl = 'erDiagram\n  CUSTOMER {\n    string name\n  }\n';
    const parsed = parseErd(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) throw new Error('unreachable');
    const out = toPortableMermaid(dsl);
    expect(out).toBe(serializeErd(parsed.model));
    expect(out).toContain('CUSTOMER {');
    expect(out).toContain('string name');
    expect(toPortableMermaid(out)).toBe(out);
  });

  it('quotes every relationship label, even a single word', () => {
    const dsl = 'erDiagram\n  A ||--o{ B : places\n  B ||--|| C : many\n';
    const out = toPortableMermaid(dsl);
    expect(out).toContain(': "places"');
    expect(out).toContain(': "many"');
  });

  it('writes a `"` inside a label as #quot;', () => {
    const out = toPortableMermaid('erDiagram\n  A ||--o{ B : "say \\"hi\\""\n');
    expect(out).toContain('#quot;');
    expect(out).not.toMatch(/: ".*".*".*"\s*$/m);
  });

  it('gives an empty label the default one, quoted', () => {
    const out = toPortableMermaid('erDiagram\n  A ||--o{ B : ""\n');
    expect(DEFAULT_RELATIONSHIP_LABEL).toBeTruthy();
    expect(out).toContain(`: "${DEFAULT_RELATIONSHIP_LABEL}"`);
  });

  it('quotes an alias (label different from the id)', () => {
    const out = toPortableMermaid('erDiagram\n  CUST[Customer Account] {\n    string name\n  }\n  CUST ||--o{ ORD : places\n');
    expect(out).toContain('CUST["Customer Account"]');
  });

  it('leaves an entity without an alias unquoted', () => {
    const out = toPortableMermaid('erDiagram\n  A ||--o{ B : places\n');
    expect(out).toMatch(/^\s*A \|\|--o\{ B : "places"/m);
    expect(out).not.toContain('"A"');
  });
});

describe('portable class diagram export', () => {
  it('writes text with nothing to adjust as the class serializer does, and a second export is stable', () => {
    const dsl = 'classDiagram\n  class A\n  class B\n  A --> B : uses\n';
    const parsed = parseUml(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) throw new Error('unreachable');
    const out = toPortableMermaid(dsl);
    expect(out).toBe(serializeUml(parsed.model));
    expect(out).toContain('A --> B : uses');
    expect(toPortableMermaid(out)).toBe(out);
  });

  it('writes each `:` in a relationship label as #58;', () => {
    const out = toPortableMermaid('classDiagram\n  class A\n  class B\n  A --> B : a:b:c\n');
    expect(out).toContain('a#58;b#58;c');
    expect(out).not.toMatch(/: a:b/);
  });

  it('drops a note with blank text', () => {
    const out = toPortableMermaid('classDiagram\n  class A\n  note "  "\n  note "kept"\n');
    expect(out).not.toContain('note "  "');
    expect(out).toContain('note "kept"');
  });

  it('drops an empty namespace, and one left empty by it (nested)', () => {
    const out = toPortableMermaid(
      'classDiagram\n  class A\n  namespace Outer {\n    namespace Inner {\n    }\n  }\n  namespace Kept {\n    class K\n  }\n',
    );
    expect(out).not.toContain('Outer');
    expect(out).not.toContain('Inner');
    expect(out).toContain('namespace Kept');
  });
});

describe('style lines on a rewritten text that starts with a config directive', () => {
  it('still gets its style lines (the family is detected from the original text)', () => {
    const dsl =
      '---\ncanvas:\n  positions:\n    A: {x: 0, y: 0}\n    B: {x: 200, y: 0}\n  styles:\n    A: {fillColor: "#ff0000"}\n---\nclassDiagram\n  %%{init: {"theme": "base"}}%%\n  class A\n  class B\n  A --> B : a:b\n';
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out.startsWith('%%{init:')).toBe(true);
    expect(out).toContain('a#58;b');
    expect(out).toContain('style A fill:#ff0000');
  });
});

describe('portable sequence export', () => {
  const HEAD = 'sequenceDiagram\n  participant A\n  participant B\n  participant C\n  participant D\n';

  it('keeps a note over one or two participants on those participants, and a second export is stable', () => {
    const dsl = `${HEAD}  Note over A,B: two\n  Note over C: one\n`;
    const out = toPortableMermaid(dsl);
    expect(out).toMatch(/Note over A,\s?B: two/);
    expect(out).toMatch(/Note over C: one/);
    expect(toPortableMermaid(out)).toBe(out);
  });

  it('spans a note over more than two participants from the first to the last declared', () => {
    const out = toPortableMermaid(`${HEAD}  Note over C, A, B: wide\n`);
    expect(out).toMatch(/Note over A,\s?C: wide/);
    expect(out).not.toMatch(/Note over [^\n]*B/);
  });
});

describe('portable flowchart export', () => {
  it('writes text with no title and no quote in a label as the flowchart serializer does, and a second export is stable', () => {
    const dsl = 'flowchart TD\n  A[One] --> B[Two]\n';
    const parsed = parseFlowchart(dsl);
    expect(isParseSuccess(parsed)).toBe(true);
    if (!isParseSuccess(parsed)) throw new Error('unreachable');
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out.trimEnd()).toBe(serializeFlowchart(parsed.model).replace(/^---\n[\s\S]*?\n---\n/, '').trimEnd());
    expect(toPortableMermaid(out, { stripFrontMatter: true })).toBe(out);
  });

  it('writes a typed flowchart with a trailing comment and odd spacing in Canvas form, without the comment', () => {
    const dsl = 'flowchart TD\n   A[One]    -->   B[Two]   %% trailing note\n%% whole-line comment\n';
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out).not.toContain('%%');
    expect(out).not.toContain('trailing');
    expect(out).toBe('flowchart TD\n  A[One]\n  B[Two]\n  A --> B\n');
  });

  it('moves a body title into the front matter as its first key', () => {
    const dsl = '---\ncanvas:\n  positions:\n    A: {x: 0, y: 0}\n---\nflowchart TD\n  title My chart\n  A[One]\n';
    const out = toPortableMermaid(dsl);
    expect(out.startsWith('---\ntitle: My chart\ncanvas:')).toBe(true);
    expect(out).not.toMatch(/^\s+title My chart/m);
  });

  it('keeps the title but drops the canvas key with stripFrontMatter', () => {
    const dsl = '---\ncanvas:\n  positions:\n    A: {x: 0, y: 0}\n---\nflowchart TD\n  title My chart\n  A[One]\n';
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out.startsWith('---\ntitle: My chart\n---\n')).toBe(true);
    expect(out).not.toContain('canvas');
  });

  it('writes a `"` in a node label as #quot;', () => {
    const out = toPortableMermaid('flowchart TD\n  A["say &quot;hi&quot;"]\n  B[Two]\n');
    expect(out).not.toMatch(/A\["say "hi""\]/);
    expect(out).toContain('#quot;');
  });
});

describe('portable style lines', () => {
  it('skips a null strokeWidth instead of writing nullpx, and keeps the other fields', () => {
    const dsl =
      '---\ncanvas:\n  positions:\n    A: {x: 0, y: 0}\n  styles:\n    A: {fillColor: "#ff0000", strokeWidth: null}\n---\nflowchart TD\n  A[One]\n';
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out).not.toContain('null');
    expect(out).toContain('style A fill:#ff0000');
    expect(out).not.toContain('stroke-width');
  });

  it('writes a real strokeWidth', () => {
    const dsl =
      '---\ncanvas:\n  positions:\n    A: {x: 0, y: 0}\n  styles:\n    A: {fillColor: "#ff0000", strokeWidth: 3}\n---\nflowchart TD\n  A[One]\n';
    expect(toPortableMermaid(dsl)).toContain('stroke-width:3px');
  });
});
