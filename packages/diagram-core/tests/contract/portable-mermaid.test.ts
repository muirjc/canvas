import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { toPortableMermaid } from '../../src/dsl/portable-mermaid.js';
import { isParseSuccess } from '../../src/dsl/types.js';
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

  it('other diagram families and unparseable input are returned unchanged', () => {
    const c4 = 'C4Context\nSystem(s, "S")\n';
    expect(toPortableMermaid(c4)).toBe(c4);
    const broken = 'flowchart TD\n  A -->\n';
    expect(toPortableMermaid(broken)).toBe(broken);
  });
});
