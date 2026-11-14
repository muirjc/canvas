// canvas-8uh1.1: drill-down links (`diagramRef`, front matter `canvas.links`) in every family. The golden corpus
// (`<family>-diagram-links`) pins reading and writing; these check edits and the ids a save keys links by.
import { describe, expect, it } from 'vitest';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { setDiagramLink, updateNodeLabel } from '../../src/model/diagram-ops.js';
import { addWardleyElement } from '../../src/model/wardley-ops.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';
import { toPortableMermaid } from '../../src/dsl/portable-mermaid.js';

function parse(family: string, text: string): DiagramModel {
  const result = getDslFamily(family)!.parse(text);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const save = (family: string, model: DiagramModel) => getDslFamily(family)!.serialize(model);
const refs = (model: DiagramModel) =>
  Object.fromEntries([...model.nodes, ...model.containers].filter((e) => e.diagramRef).map((e) => [e.id, e.diagramRef!.diagramId]));

const SAMPLES: Record<string, [string, string]> = {
  flowchart: ['flowchart TD\n  A[One] --> B[Two]\n', 'A'],
  c4: ['C4Context\n  System(pay, "Payments")\n', 'pay'],
  erd: ['erDiagram\n  CUSTOMER ||--o{ ORDER : places\n', 'CUSTOMER'],
  uml: ['classDiagram\n  class Order\n', 'Order'],
  architecture: ['architecture-beta\n  service api(server)[API]\n', 'api'],
  state: ['stateDiagram-v2\n  [*] --> Idle\n', 'Idle'],
  sequence: ['sequenceDiagram\n  participant API\n  API->>API: tick\n', 'API'],
  wardley: ['wardley-beta\ncomponent Tea [0.5, 0.5]\n', 'Tea'],
};

describe('a link set in the editor survives a save in every family', () => {
  for (const [family, [text, id]] of Object.entries(SAMPLES)) {
    it(family, () => {
      const linked = setDiagramLink(parse(family, text), id, 'target-diagram-1');
      const saved = save(family, linked);
      expect(saved).toContain(`links:\n    ${id}: target-diagram-1`);
      expect(refs(parse(family, saved))).toEqual({ [id]: 'target-diagram-1' });
      // Saving the read-back text changes nothing.
      expect(save(family, parse(family, saved))).toBe(saved);
      // Removing it removes the front matter section.
      expect(save(family, setDiagramLink(parse(family, saved), id, null))).not.toContain('links:');
    });
  }
});

describe('setDiagramLink', () => {
  const model = parse('flowchart', 'flowchart TD\n  subgraph g [G]\n    A --> B\n  end\n');
  it('links a group too, and leaves the input alone', () => {
    const before = JSON.stringify(model);
    const next = setDiagramLink(model, 'g', 'abc-123');
    expect(next.containers[0].diagramRef).toEqual({ diagramId: 'abc-123' });
    expect(JSON.stringify(model)).toBe(before);
  });
  it('replaces a link in place and removes one', () => {
    const once = setDiagramLink(model, 'A', 'first');
    const twice = setDiagramLink(once, 'A', 'second');
    expect(twice.nodes.find((n) => n.id === 'A')!.diagramRef).toEqual({ diagramId: 'second' });
    expect('diagramRef' in setDiagramLink(twice, 'A', null).nodes.find((n) => n.id === 'A')!).toBe(false);
  });
  it('refuses an unknown element and a value that is not a diagram id', () => {
    expect(() => setDiagramLink(model, 'nope', 'abc')).toThrow('there is no shape or group "nope"');
    for (const bad of ['', 'has space', '../x', 'a'.repeat(101), '-leading']) {
      expect(() => setDiagramLink(model, 'A', bad)).toThrow('is not a diagram id');
    }
  });
});

describe('front matter that is not a link is dropped, never an error', () => {
  it('ignores unknown ids, bad values and a links section that is not a map', () => {
    const text = (links: string) => `---\ncanvas:\n  links: ${links}\n---\nflowchart TD\n  A --> B\n`;
    expect(refs(parse('flowchart', text('[a, b]')))).toEqual({});
    expect(refs(parse('flowchart', text('{ A: 12, B: "x y", C: ok }')))).toEqual({});
    expect(refs(parse('flowchart', text('{ A: ok-1, toString: ok-2 }')))).toEqual({ A: 'ok-1' });
  });
  it('keeps a sequence link on a participant only (a block id is made up by the parser)', () => {
    const model = parse('sequence', '---\ncanvas:\n  links:\n    API: d1\n---\nsequenceDiagram\n  participant API\n  loop Every minute\n    API->>API: tick\n  end\n');
    expect(refs(model)).toEqual({ API: 'd1' });
    const block = model.containers[0].id;
    const saved = save('sequence', setDiagramLink(model, block, 'd2'));
    expect(saved).not.toContain('d2');
  });
});

describe('a Wardley map keys a link by the id the element has once read back', () => {
  const map = 'wardley-beta\ncomponent Kettle [0.4, 0.3]\npipeline Kettle {\n  component Electric [0.45]\n}\nnote "First" [0.2, 0.2]\nnote "Second" [0.3, 0.3]\n';
  it('follows a renamed component (its id is its name)', () => {
    const model = updateNodeLabel(setDiagramLink(parse('wardley', map), 'Kettle', 'k1'), 'Kettle', 'Boiler');
    const saved = save('wardley', model);
    expect(saved).toContain('    Boiler: k1');
    expect(refs(parse('wardley', saved))).toEqual({ Boiler: 'k1' });
  });
  it('keys a pipeline component by its parent and name, a pipeline by its parent, and notes by their place', () => {
    let model = parse('wardley', map);
    model = setDiagramLink(model, 'Kettle_Electric', 'e1');
    model = setDiagramLink(model, '~pipeline:Kettle', 'p1');
    model = setDiagramLink(model, '~note2', 'n2');
    model = updateNodeLabel(model, 'Kettle', 'Boiler');
    const reread = parse('wardley', save('wardley', model));
    expect(refs(reread)).toEqual({ Boiler_Electric: 'e1', '~pipeline:Boiler': 'p1', '~note2': 'n2' });
  });
  it('keys an element added in the editor (a generated id) by its name', () => {
    const added = addWardleyElement(parse('wardley', map), { kind: 'component', label: 'Water' });
    const id = added.nodes[added.nodes.length - 1].id;
    const reread = parse('wardley', save('wardley', setDiagramLink(added, id, 'w1')));
    expect(refs(reread)).toEqual({ Water: 'w1' });
  });
  it('writes no front matter when nothing links', () => {
    expect(save('wardley', parse('wardley', map)).startsWith('wardley-beta')).toBe(true);
  });
});

// canvas-8uh1.4: links in exports.
const BASE = 'https://canvas.example.com/?diagramId=';
const TARGET = '11111111-2222-4333-8444-555555555555';

describe('an SVG export links a linked element to its diagram', () => {
  for (const [family, [text, id]] of Object.entries(SAMPLES)) {
    it(family, () => {
      const model = setDiagramLink(parse(family, text), id, TARGET);
      const svg = renderToSvg(model, undefined, { diagramLinkBase: BASE });
      expect(svg).toContain(`<a href="${BASE}${TARGET}">`);
      expect(svg.match(/<a /g)).toHaveLength(1);
      // Without a base, the drawing is exactly as before.
      expect(renderToSvg(model)).toBe(renderToSvg(parse(family, text)));
    });
  }

  it('a group links too', () => {
    const model = setDiagramLink(parse('flowchart', 'flowchart TD\n  subgraph one [Group]\n    A\n  end\n'), 'one', TARGET);
    expect(renderToSvg(model, undefined, { diagramLinkBase: BASE })).toMatch(new RegExp(`<a href="${BASE.replace(/[?.]/g, '\\$&')}${TARGET}"><g data-container-id="one">`));
  });

  it("a shape's own click link wins and the base is escaped", () => {
    const own = setDiagramLink(parse('flowchart', 'flowchart TD\n  A --> B\n  click A href "https://example.com/own"\n'), 'A', TARGET);
    const svg = renderToSvg(own, undefined, { diagramLinkBase: BASE });
    expect(svg).toContain('href="https://example.com/own"');
    expect(svg).not.toContain(TARGET);
    const odd = renderToSvg(setDiagramLink(parse('flowchart', 'flowchart TD\n  A\n'), 'A', TARGET), undefined, { diagramLinkBase: 'https://c.example/?a=1&diagramId=' });
    expect(odd).toContain('href="https://c.example/?a=1&amp;diagramId=');
    // A base that isn't a link Canvas allows draws no link at all.
    expect(renderToSvg(setDiagramLink(parse('flowchart', 'flowchart TD\n  A\n'), 'A', TARGET), undefined, { diagramLinkBase: 'javascript:alert(1)//' })).not.toContain('<a ');
  });
});

describe('the portable export writes click lines where Mermaid has them', () => {
  const linked = (family: string) => {
    const [text, id] = SAMPLES[family];
    return save(family, setDiagramLink(parse(family, text), id, TARGET));
  };

  it('flowchart and state', () => {
    for (const [family, id] of [['flowchart', 'A'], ['state', 'Idle']]) {
      const out = toPortableMermaid(linked(family), { stripFrontMatter: true, diagramLinkBase: BASE });
      expect(out).toContain(`click ${id} href "${BASE}${TARGET}"`);
      expect(out).not.toContain('links:');
      // Without a base, no click line.
      expect(toPortableMermaid(linked(family), { stripFrontMatter: true })).not.toContain('click');
    }
  });

  it('other families keep their links in the front matter only', () => {
    for (const family of ['c4', 'erd', 'uml', 'architecture', 'sequence', 'wardley']) {
      expect(toPortableMermaid(linked(family), { stripFrontMatter: true, diagramLinkBase: BASE })).not.toContain(TARGET);
    }
  });
});
