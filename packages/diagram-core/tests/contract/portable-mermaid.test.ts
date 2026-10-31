import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { toPortableMermaid } from '../../src/dsl/portable-mermaid.js';
import { isParseSuccess, type ParseResult } from '../../src/dsl/types.js';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { parseErd, serializeErd } from '../../src/dsl/erd.js';
import { parseUml, serializeUml } from '../../src/dsl/uml.js';
import { parseSequence, serializeSequence } from '../../src/dsl/sequence.js';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * canvas-jki: flowchart colours live in Canvas's `canvas:` front matter, which other Mermaid tools
 * ignore, so an exported .mmd lost every colour outside Canvas. The export now appends plain
 * `style` / `linkStyle` lines carrying the same values; the saved DSL is untouched.
 */

function parseOk(dsl: string): DiagramModel {
  const result = parseFlowchart(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

/** A saved flowchart: two kinds with swatches, a hand-coloured edge, a chained edge before it. */
function savedDsl(): string {
  const model = parseOk('flowchart LR\n  A[Inbound]:::primary_activity --> B[Operations]:::primary_activity --> C[HR]\n  C --> A\n');
  model.nodes.find((n) => n.id === 'A')!.style = { fillColor: '#dbeafe', strokeColor: '#1e3a8a' };
  model.nodes.find((n) => n.id === 'B')!.style = { fillColor: '#fef3c7' };
  model.edges[2].style = { strokeColor: '#ef4444', strokeWidth: 2, strokeDasharray: '5 5' };
  return serializeFlowchart(model);
}

describe('toPortableMermaid', () => {
  it('adds a style line per coloured node and a linkStyle line per coloured edge, by declaration index', () => {
    const out = toPortableMermaid(savedDsl());
    expect(out).toContain('  style A fill:#dbeafe,stroke:#1e3a8a');
    expect(out).toContain('  style B fill:#fef3c7');
    expect(out).not.toMatch(/style C /);
    // The chain A --> B --> C is two edges, so C --> A is index 2.
    expect(out).toContain('  linkStyle 2 stroke:#ef4444,stroke-width:2px,stroke-dasharray:5 5');
  });

  it('writes a comma-separated dasharray with spaces (commas separate Mermaid style properties)', () => {
    const model = parseOk('flowchart TD\n  A --> B\n');
    model.edges[0].style = { strokeDasharray: '4,2' };
    expect(toPortableMermaid(serializeFlowchart(model))).toContain('  linkStyle 0 stroke-dasharray:4 2');
  });

  it('keeps the saved DSL intact above the added lines, kinds included', () => {
    const saved = savedDsl();
    const out = toPortableMermaid(saved);
    expect(out.startsWith(saved.replace(/\s+$/, ''))).toBe(true);
    expect(out).toContain(':::primary_activity');
  });

  it('re-importing the exported file gives the same diagram', () => {
    const saved = savedDsl();
    const reimported = parseOk(toPortableMermaid(saved));
    const original = parseOk(saved);
    expect(reimported.nodes.map((n) => [n.id, n.role, n.style])).toEqual(original.nodes.map((n) => [n.id, n.role, n.style]));
    expect(reimported.edges.map((e) => e.style)).toEqual(original.edges.map((e) => e.style));
    expect(serializeFlowchart(reimported)).toBe(serializeFlowchart(original));
  });

  it('a flowchart with nothing coloured is returned unchanged', () => {
    const dsl = 'flowchart TD\n  A --> B\n';
    expect(toPortableMermaid(dsl)).toBe(dsl);
  });

  it('uncoloured diagrams of other families and unparseable input are returned unchanged', () => {
    const c4 = 'C4Context\nSystem(s, "S")\n';
    expect(toPortableMermaid(c4)).toBe(c4);
    const broken = 'flowchart TD\n  A -->\n';
    expect(toPortableMermaid(broken)).toBe(broken);
  });
});

// canvas-3s5.1: the reviewer-facing .mmd in a GitHub pull request carries no Canvas front matter
// (GitHub and other tools ignore or choke on the canvas: block); Mermaid's own keys stay.
describe('toPortableMermaid(dsl, { stripFrontMatter: true })', () => {
  it('drops the canvas: front matter but keeps the colours as style lines', () => {
    const out = toPortableMermaid(savedDsl(), { stripFrontMatter: true });
    expect(out).not.toMatch(/^---/);
    expect(out).not.toContain('canvas:');
    expect(out).toContain('style ');
    expect(out.trimStart().startsWith('flowchart') || out.trimStart().startsWith('graph')).toBe(true);
  });

  it("keeps Mermaid's own front-matter keys (title, config) and removes only canvas:", () => {
    const dsl = ['---', 'title: Order flow', 'config:', '  theme: neutral', 'canvas:', '  positions:', '    A: { x: 10, y: 20 }', '---', 'flowchart TD', '  A[Start] --> B[End]', ''].join('\n');
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('title: Order flow');
    expect(out).toContain('theme: neutral');
    expect(out).not.toContain('canvas:');
    expect(out).not.toContain('positions');
    expect(out).toContain('flowchart TD');
  });

  it('strips front matter for non-flowchart families too', () => {
    const dsl = ['---', 'canvas:', '  positions:', '    a: { x: 1, y: 2 }', '---', 'erDiagram', '  CUSTOMER ||--o{ ORDER : places', ''].join('\n');
    const out = toPortableMermaid(dsl, { stripFrontMatter: true });
    expect(out).not.toContain('canvas:');
    expect(out.trimStart().startsWith('erDiagram')).toBe(true);
  });

  it('leaves text without front matter as it was, and the default call keeps the front matter', () => {
    const plain = 'flowchart TD\n  A --> B\n';
    expect(toPortableMermaid(plain, { stripFrontMatter: true })).toBe(plain);
    expect(toPortableMermaid(savedDsl())).toContain('canvas:');
  });
});

// canvas-n85n: the other families whose Mermaid grammar can carry colour, checked against the
// Mermaid GitHub renders with (v12.2.0): C4 macros, ER and class `style` lines.
function ok(result: ParseResult): DiagramModel {
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

function c4Saved(): string {
  const model = ok(parseC4('C4Context\nPerson(u, "User")\nSystem(s, "Shop")\nSystem_Ext(p, "Payments")\nRel(u, s, "Uses")\nRel(s, p, "Pays")\nRel(s, p, "Refunds")\n'));
  model.nodes.find((n) => n.id === 's')!.style = { fillColor: '#d62728', strokeColor: '#2ca02c', strokeWidth: 3 };
  model.nodes.find((n) => n.id === 'p')!.style = { strokeColor: '#1f77b4' };
  model.edges[0].style = { strokeColor: '#ff7f0e' };
  // Two rels between s and p in different colours: Mermaid can't tell them apart.
  model.edges[1].style = { strokeColor: '#9467bd' };
  model.edges[2].style = { strokeColor: '#8c564b' };
  return serializeC4(model);
}

function erdSaved(): string {
  const model = ok(parseErd('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains\n'));
  model.nodes.find((n) => n.id === 'CUSTOMER')!.style = { fillColor: '#d62728', strokeColor: '#2ca02c' };
  // '4 2', not '4,2': a comma dasharray comes back with spaces (same drawing), see the flowchart test.
  model.nodes.find((n) => n.id === 'ORDER')!.style = { strokeWidth: 2, strokeDasharray: '4 2' };
  return serializeErd(model);
}

function umlSaved(): string {
  const model = ok(parseUml('classDiagram\n  class Animal\n  class Dog\n  Animal <|-- Dog\n  namespace Zoo {\n    class Keeper\n  }\n'));
  model.nodes.find((n) => n.id === 'Animal')!.style = { fillColor: '#d62728', strokeColor: '#2ca02c' };
  model.nodes.find((n) => n.id === 'Keeper')!.style = { fillColor: '#ff7f0e' };
  model.edges[0].style = { strokeColor: '#1f77b4' };
  return serializeUml(model);
}

describe('toPortableMermaid: C4, ER and class diagrams (canvas-n85n)', () => {
  it('C4: UpdateElementStyle per coloured element and UpdateRelStyle per coloured pair, colours only', () => {
    const out = toPortableMermaid(c4Saved(), { stripFrontMatter: true });
    expect(out).toContain('UpdateElementStyle(s, $bgColor="#d62728", $borderColor="#2ca02c")');
    expect(out).toContain('UpdateElementStyle(p, $borderColor="#1f77b4")');
    expect(out).not.toMatch(/UpdateElementStyle\(u,/);
    expect(out).toContain('UpdateRelStyle(u, s, $lineColor="#ff7f0e")');
    // s -> p has two rels in different colours; Mermaid matches by endpoints, so none is written.
    expect(out.match(/UpdateRelStyle/g)).toHaveLength(1);
    expect(out).not.toContain('stroke-width');
  });

  it('ER: a style line per coloured entity, with width and dash pattern', () => {
    const out = toPortableMermaid(erdSaved(), { stripFrontMatter: true });
    expect(out).toContain('\nstyle CUSTOMER fill:#d62728,stroke:#2ca02c');
    expect(out).toContain('\nstyle ORDER stroke-width:2px,stroke-dasharray:4 2');
    expect(out).not.toMatch(/style LINE_ITEM/);
    expect(out).not.toContain('linkStyle');
  });

  it('class: a style line per coloured class (namespaced ones too), and no linkStyle (not class syntax)', () => {
    const out = toPortableMermaid(umlSaved(), { stripFrontMatter: true });
    expect(out).toContain('\nstyle Animal fill:#d62728,stroke:#2ca02c');
    expect(out).toContain('\nstyle Keeper fill:#ff7f0e');
    expect(out).not.toContain('linkStyle');
  });

  it.each([
    ['C4', c4Saved, parseC4, serializeC4],
    ['ER', erdSaved, parseErd, serializeErd],
    ['class', umlSaved, parseUml, serializeUml],
  ] as const)('%s: re-importing the exported file (front matter kept) gives the same diagram', (_name, saved, parse, serialize) => {
    const original = ok(parse(saved()));
    const reimported = ok(parse(toPortableMermaid(saved())));
    expect(reimported.nodes.map((n) => [n.id, n.style])).toEqual(original.nodes.map((n) => [n.id, n.style]));
    expect(reimported.edges.map((e) => e.style)).toEqual(original.edges.map((e) => e.style));
    expect(serialize(reimported)).toBe(serialize(original));
  });

  it.each([
    ['C4', c4Saved, parseC4],
    ['ER', erdSaved, parseErd],
    ['class', umlSaved, parseUml],
  ] as const)('%s: the stripped file (what GitHub gets) still parses and keeps the colours Mermaid can show', (_name, saved, parse) => {
    const original = ok(parse(saved()));
    const reimported = ok(parse(toPortableMermaid(saved(), { stripFrontMatter: true })));
    for (const node of original.nodes) {
      const back = reimported.nodes.find((n) => n.id === node.id)!;
      expect(back.style?.fillColor).toBe(node.style?.fillColor);
      expect(back.style?.strokeColor).toBe(node.style?.strokeColor);
    }
  });

  it('C4: rels between one pair that all share a colour get one UpdateRelStyle line', () => {
    const model = ok(parseC4('C4Context\nSystem(a, "A")\nSystem(b, "B")\nRel(a, b, "x")\nRel(a, b, "y")\n'));
    model.edges.forEach((edge) => (edge.style = { strokeColor: '#17becf' }));
    const out = toPortableMermaid(serializeC4(model));
    expect(out.match(/UpdateRelStyle\(a, b, \$lineColor="#17becf"\)/g)).toHaveLength(1);
  });

  it('sequence and architecture diagrams are returned unchanged (no colour syntax in Mermaid)', () => {
    const seq = ok(parseSequence('sequenceDiagram\n  participant A\n  participant B\n  A->>B: hi\n'));
    seq.nodes[0].style = { fillColor: '#d62728' };
    const seqDsl = serializeSequence(seq);
    expect(toPortableMermaid(seqDsl)).toBe(seqDsl);

    const arch = ok(parseArchitecture('architecture-beta\n  service a(server)[A]\n  service b(database)[B]\n  a:R --> L:b\n'));
    arch.nodes[0].style = { fillColor: '#d62728' };
    const archDsl = serializeArchitecture(arch);
    expect(toPortableMermaid(archDsl)).toBe(archDsl);
  });
});
