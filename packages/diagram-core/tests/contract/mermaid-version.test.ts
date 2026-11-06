// canvas-7p3y: the Mermaid version Canvas's syntax follows, and the notes on what it doesn't read.
// The version is pinned so a change is deliberate (the upgrade process in
// docs/admin-guide/operations.md). The notes are checked against the parsers: when one of these
// starts to parse, the note (and this test) must be updated.
import { describe, expect, it } from 'vitest';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { GITHUB_MERMAID_VERSION, MERMAID_SUPPORT_NOTES, MERMAID_SYNTAX_VERSION, mermaidMajorVersion } from '../../src/mermaid-version.js';

const parses = (family: string, dsl: string) => isParseSuccess(getDslFamily(family)!.parse(dsl));

describe('Mermaid version', () => {
  it('is pinned', () => {
    expect(MERMAID_SYNTAX_VERSION).toBe('12.3');
    expect(GITHUB_MERMAID_VERSION).toEqual({ version: '12.2.0', checkedOn: '2026-11-05' });
    expect(mermaidMajorVersion(GITHUB_MERMAID_VERSION.version)).toBe(12);
    expect(mermaidMajorVersion(MERMAID_SYNTAX_VERSION)).toBe(12);
  });

  it('has a note entry for every family Canvas reads', () => {
    expect(MERMAID_SUPPORT_NOTES.map((n) => n.family).sort()).toEqual(['architecture', 'c4', 'erd', 'flowchart', 'sequence', 'state', 'uml']);
  });

  it.each([
    ['flowchart', 'flowchart TD\n  A\n  click A call cb()\n'],
    ['state', 'stateDiagram-v2\n  note "floating" as N\n'],
    ['sequence', 'sequenceDiagram\n  properties A: {"class": "x"}\n  A->>B: hi\n'],
    ['sequence', 'sequenceDiagram\n  details A: menu\n  A->>B: hi\n'],
  ])('%s: still not read, as the notes say: %j', (family, dsl) => {
    expect(parses(family, dsl)).toBe(false);
  });

  it.each([
    ['flowchart', 'flowchart TD\n  A\n  click A href "https://example.org"\n'],
    ['flowchart', 'flowchart TD\n  A@{ shape: doc, label: "x" }\n  B@{ icon: "fa:user", img: "https://example.org/a.png" }\n'],
    ['flowchart', 'flowchart TD\n  A e1@--> B\n  e1@{ animate: true, animation: fast, curve: linear, step: 1 }\n'],
    ['flowchart', 'flowchart TD\n  A ---> B -..-> C ===> D\n  D -- label ----> E\n'],
    ['flowchart', 'flowchart TD\n  subgraph one\n    A\n  end\n  one@{ view: collapsed, algorithm: elk.box }\n'],
    ['c4', 'C4Deployment\n  Node_L(n, "N") {\n  }\n  UpdateLayoutConfig($c4ShapeInRow="3")\n'],
    ['architecture', 'architecture-beta\n  service s(logos:aws-lambda)[S]\n'],
    ['state', 'stateDiagram-v2\n  hide empty description\n  scale 600 width\n  A --> B\n'],
    ['uml', 'classDiagram\n  class A["Label"]\n'],
    ['erd', 'erDiagram\n  P {\n    string? middleName\n    string `first name` PK\n  }\n'],
    ['erd', 'erDiagram\n  subgraph "Customer Domain" [Customers]\n    direction LR\n    CUSTOMER\n  end\n  "Customer Domain" ||--o{ ORDER : places\n'],
    ['sequence', 'sequenceDiagram\n  A -|\\ B: hi\n  A ->>() B: hi\n  link A: Dash @ https://example.org\n'],
    ['sequence', 'sequenceDiagram\n  participant D@{ "type": "database" }\n  autonumber .5 0.25\n  D->>E: hi\n'],
  ])('%s: read, as the notes say: %j', (family, dsl) => {
    expect(parses(family, dsl)).toBe(true);
  });
});
