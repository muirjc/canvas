// canvas-4h1j: Mermaid Wardley maps (`wardley-beta`). The golden corpus (corpus/cases/wardley-*) pins whole
// outputs; these pin the rules behind them, against Mermaid's grammar (wardley.langium) and its parser/renderer.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectDslFamily } from '../../src/dsl/detect.js';
import { toPortableMermaid } from '../../src/dsl/portable-mermaid.js';
import {
  layOutPipelines,
  parseWardley,
  serializeWardley,
  wardleyName,
  wardleyNumber,
  wardleyPipelineBox,
  wardleyPositionsFromCoordinates,
} from '../../src/dsl/wardley.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { addNode } from '../../src/model/diagram-ops.js';
import { wardleyFrame, wardleyPercent, wardleyPoint } from '../../src/model/wardley-geometry.js';
import { computeWardleyLayout } from '../../src/render/wardley-render.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';

const H = 'wardley-beta\n';

function parse(dsl: string): DiagramModel {
  const result = parseWardley(dsl);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const errors = (dsl: string) => {
  const result = parseWardley(dsl);
  return isParseSuccess(result) ? [] : result.errors.map((e) => e.message);
};
const node = (m: DiagramModel, id: string) => m.nodes.find((n) => n.id === id)!;
const svg = (dsl: string) => renderToSvg(parse(dsl));
const count = (text: string, needle: string | RegExp) =>
  typeof needle === 'string' ? text.split(needle).length - 1 : (text.match(needle) ?? []).length;

describe('wardley maps: detection and header', () => {
  it('is detected from the lower case header only', () => {
    expect(detectDslFamily(`${H}component A [0.5, 0.5]\n`)).toBe('wardley');
    expect(detectDslFamily('WARDLEY-BETA\ncomponent A [0.5, 0.5]\n')).not.toBe('wardley');
    expect(detectDslFamily('Wardley-Beta\n')).not.toBe('wardley');
  });

  it('is detected after a config directive', () => {
    const dsl = `%%{init: {"theme": "forest"}}%%\n${H}component A [0.5, 0.5]\n`;
    expect(detectDslFamily(dsl)).toBe('wardley');
    const m = parse(dsl);
    expect(m.diagramTypeId).toBe('wardley');
    expect(serializeWardley(m).startsWith(`%%{init: {"theme": "forest"}}%%\n${H}`)).toBe(true);
  });

  it('refuses text that does not start with the header', () => {
    expect(errors('component A [0.5, 0.5]\n')[0]).toMatch(/wardley-beta/);
    expect(errors('WARDLEY-BETA\n')[0]).toMatch(/wardley-beta/);
    expect(errors('')[0]).toMatch(/wardley-beta/);
  });

  it('allows a trailing comment on the header and comments anywhere', () => {
    const m = parse(`%% a comment\n`.replace('%% a comment\n', '') + `${H.trim()} %% note\n%% whole line\ncomponent A [0.5, 0.5] %% trailing\n`);
    expect(m.nodes.map((n) => n.id)).toEqual(['A']);
  });

  it('refuses a comment before the header', () => {
    expect(errors(`%% hello\n${H}`)[0]).toMatch(/wardley-beta/);
  });
});

describe('wardley maps: title and accessibility lines', () => {
  it('reads title, accTitle and single line accDescr', () => {
    const m = parse(`${H}title My Map\naccTitle: Short\naccDescr: Long text\n`);
    expect(m.title).toBe('My Map');
    expect(m.accTitle).toBe('Short');
    expect(m.accDescr).toBe('Long text');
  });

  it('reads an accDescr block over several lines', () => {
    const m = parse(`${H}accDescr {\n  first line\n  second line\n}\ncomponent A [0.5, 0.5]\n`);
    expect(m.accDescr).toBe('first line\nsecond line');
    expect(m.nodes).toHaveLength(1);
    const again = parse(serializeWardley(m));
    expect(again.accDescr).toBe('first line\nsecond line');
  });

  it('reads an accDescr block opened and closed on one line', () => {
    expect(parse(`${H}accDescr { just one }\n`).accDescr).toBe('just one');
  });

  it('refuses an accDescr block that never closes', () => {
    expect(errors(`${H}accDescr {\n  open\n`)[0]).toMatch(/closing/);
  });

  it('ends a title at a comment', () => {
    expect(parse(`${H}title Tea %% hidden\n`).title).toBe('Tea');
  });
});

describe('wardley maps: size and evolution', () => {
  it('reads the size and defaults to 900 x 600', () => {
    expect(parse(`${H}size [1100, 800]\n`).wardley?.size).toEqual({ width: 1100, height: 800 });
    expect(parse(H).wardley).toBeUndefined();
    expect(wardleyFrame(parse(H))).toMatchObject({ width: 900, height: 600, padding: 48 });
  });

  it('refuses a decimal size', () => {
    expect(errors(`${H}size [1100.5, 800]\n`)).toHaveLength(1);
  });

  it('reads stages with boundaries and a second name', () => {
    const m = parse(`${H}evolution Genesis@0.25 / Concept -> "Custom Built"@0.5 -> Product -> Commodity@1.0\n`);
    expect(m.wardley?.stages).toEqual([
      { name: 'Genesis', boundary: 0.25, secondName: 'Concept' },
      { name: 'Custom Built', boundary: 0.5 },
      { name: 'Product' },
      { name: 'Commodity', boundary: 1.0 },
    ]);
  });

  it('reads two stages', () => {
    expect(parse(`${H}evolution Before -> After\n`).wardley?.stages).toEqual([{ name: 'Before' }, { name: 'After' }]);
  });

  it('reads stage names with spaces and a trailing comment', () => {
    expect(parse(`${H}evolution Not Yet -> Done Now %% x\n`).wardley?.stages?.map((s) => s.name)).toEqual(['Not Yet', 'Done Now']);
  });

  it('refuses a single stage and a missing arrow', () => {
    expect(errors(`${H}evolution Only\n`)[0]).toMatch(/two stages/);
    expect(errors(`${H}evolution A B -> \n`)).toHaveLength(1);
    expect(errors(`${H}evolution A => B\n`)).toHaveLength(1);
  });

  it('refuses an integer boundary', () => {
    expect(errors(`${H}evolution A@1 -> B\n`)).toHaveLength(1);
  });
});

describe('wardley maps: anchors and components', () => {
  it('reads an anchor', () => {
    const m = parse(`${H}anchor Customer [0.95, 0.63]\n`);
    expect(node(m, 'Customer')).toMatchObject({ role: 'anchor', label: 'Customer', wardley: { visibility: 0.95, evolution: 0.63 } });
  });

  it('places a component from [visibility, evolution]', () => {
    const m = parse(`${H}component Cup [0.5, 0.25]\n`);
    // x = 48 + 0.25 * 804, y = 552 - 0.5 * 504
    expect(node(m, 'Cup').position).toEqual({ x: 249, y: 300 });
    expect(node(m, 'Cup').role).toBe('component');
  });

  it('reads a label offset with negatives and spaces', () => {
    const m = parse(`${H}component A [0.5, 0.5] label [ -10 , 20 ]\ncomponent B [0.5, 0.5] label[5,-7]\ncomponent C [0.5, 0.5] label [- 3, - 4]\n`);
    expect(node(m, 'A').wardley?.labelOffset).toEqual({ x: -10, y: 20 });
    expect(node(m, 'B').wardley?.labelOffset).toEqual({ x: 5, y: -7 });
    expect(node(m, 'C').wardley?.labelOffset).toEqual({ x: -3, y: -4 });
  });

  it('reads every strategy', () => {
    for (const strategy of ['build', 'buy', 'outsource', 'market']) {
      expect(node(parse(`${H}component A [0.5, 0.5] (${strategy})\n`), 'A').wardley?.strategy).toBe(strategy);
    }
    expect(errors(`${H}component A [0.5, 0.5] (rent)\n`)).toHaveLength(1);
  });

  it('reads inertia in both forms', () => {
    expect(node(parse(`${H}component A [0.5, 0.5] inertia\n`), 'A').wardley?.inertia).toBe(true);
    expect(node(parse(`${H}component A [0.5, 0.5] (inertia)\n`), 'A').wardley?.inertia).toBe(true);
    expect(node(parse(`${H}component A [0.5, 0.5]\n`), 'A').wardley?.inertia).toBeUndefined();
  });

  it('takes label, then strategy, then inertia, in that order only', () => {
    const m = parse(`${H}component A [0.5, 0.5] label [1, 2] (buy) inertia\n`);
    expect(node(m, 'A').wardley).toMatchObject({ labelOffset: { x: 1, y: 2 }, strategy: 'buy', inertia: true });
    expect(errors(`${H}component A [0.5, 0.5] (buy) label [1, 2]\n`)).toHaveLength(1);
    expect(errors(`${H}component A [0.5, 0.5] inertia (buy)\n`)).toHaveLength(1);
    expect(errors(`${H}component A [0.5, 0.5] (buy) (build)\n`)).toHaveLength(1);
    expect(errors(`${H}component A [0.5, 0.5] inertia label [1, 2]\n`)).toHaveLength(1);
  });

  it('refuses a fractional label offset', () => {
    expect(errors(`${H}component A [0.5, 0.5] label [1.5, 2]\n`)).toHaveLength(1);
  });

  it('merges a repeated name, later wins, and keeps the label offset', () => {
    const m = parse(`${H}component A [0.2, 0.2] label [5, 6] (buy)\ncomponent A [0.7, 0.8]\n`);
    expect(m.nodes).toHaveLength(1);
    expect(node(m, 'A').wardley).toMatchObject({ visibility: 0.7, evolution: 0.8, labelOffset: { x: 5, y: 6 } });
    expect(node(m, 'A').wardley?.strategy).toBeUndefined();
    const second = parse(`${H}component A [0.2, 0.2] label [5, 6]\ncomponent A [0.7, 0.8] label [1, 1]\n`);
    expect(node(second, 'A').wardley?.labelOffset).toEqual({ x: 1, y: 1 });
  });

  it('takes effect by kind, not text order: a component declared after its pipeline still works', () => {
    const m = parse(`${H}pipeline P {\n  component Child [0.4]\n}\ncomponent P [0.6, 0.5]\n`);
    expect(m.nodes.map((n) => n.id)).toEqual(['P', 'P_Child']);
    expect(node(m, 'P_Child').wardley?.visibility).toBe(0.6);
  });

  it('puts anchors before components, whatever the text order', () => {
    const m = parse(`${H}component C [0.5, 0.5]\nanchor A [0.9, 0.5]\n`);
    expect(m.nodes.map((n) => n.id)).toEqual(['A', 'C']);
  });
});

describe('wardley maps: coordinates', () => {
  it('must be decimals, and the message says so', () => {
    for (const bad of ['component A [1, 0.5]', 'component A [.5, 0.5]', 'component A [0.5, 1]', 'anchor A [1, 1]', 'note "x" [1, 1]', 'evolve A 1']) {
      const e = errors(`${H}component A [0.5, 0.5]\n${bad}\n`);
      expect(e, bad).toHaveLength(1);
      expect(e[0], bad).toMatch(/decimals/);
    }
  });

  it('takes 1.0 and 0.0 and a percentage', () => {
    const m = parse(`${H}component A [1.0, 0.0]\ncomponent B [50.0, 100.0]\n`);
    expect(node(m, 'A').position).toEqual({ x: 48, y: 48 });
    expect(node(m, 'B').position).toEqual({ x: 852, y: 300 });
  });

  it('treats 0-1 as a fraction and above 1 as a percentage', () => {
    expect(wardleyPercent(0.35)).toBe(35);
    expect(wardleyPercent(1.0)).toBe(100);
    expect(wardleyPercent(35.0)).toBe(35);
    const m = parse(`${H}component A [0.35, 0.35]\ncomponent B [35.0, 35.0]\n`);
    expect(node(m, 'A').position.x).toBeCloseTo(node(m, 'B').position.x, 9);
    expect(node(m, 'A').position.y).toBeCloseTo(node(m, 'B').position.y, 9);
  });

  it('refuses a value over 100 with Mermaid\'s message', () => {
    const e = errors(`${H}component A [0.5, 100.5]\n`);
    expect(e).toHaveLength(1);
    expect(e[0]).toBe('Component "A" evolution must be between 0-1 (decimal) or 0-100 (percentage). Received: 100.5');
    expect(errors(`${H}anchor A [150.0, 0.5]\n`)[0]).toMatch(/visibility must be between 0-1 \(decimal\) or 0-100 \(percentage\)/);
    expect(errors(`${H}note "x" [0.5, 101.0]\n`)[0]).toMatch(/Received: 101/);
    expect(errors(`${H}component A [0.5, 0.5]\nevolve A 120.0\n`)[0]).toMatch(/Received: 120/);
  });
});

describe('wardley maps: names', () => {
  it('reads quoted names with escaped quotes, in either quote style', () => {
    const m = parse(`${H}component "Say \\"hi\\"" [0.5, 0.5]\ncomponent 'It\\'s' [0.4, 0.4]\ncomponent 'Dq "x"' [0.3, 0.3]\n`);
    expect(m.nodes.map((n) => n.id)).toEqual(['Say "hi"', "It's", 'Dq "x"']);
  });

  it('reads hyphenated names, but not through an arrow', () => {
    const m = parse(`${H}component real-time processing [0.5, 0.5]\ncomponent A [0.4, 0.4]\ncomponent B [0.3, 0.3]\nA->B\n`);
    expect(m.nodes.map((n) => n.id)).toEqual(['real-time processing', 'A', 'B']);
    expect(m.edges.map((e) => [e.sourceId, e.targetId])).toEqual([['A', 'B']]);
  });

  it('reads names with spaces, parentheses and ampersands', () => {
    const m = parse(`${H}component byte pair encoding (BPE) [0.5, 0.5]\ncomponent R&D [0.4, 0.4]\n`);
    expect(m.nodes.map((n) => n.id)).toEqual(['byte pair encoding (BPE)', 'R&D']);
  });

  it('reads a name that starts with an underscore', () => {
    expect(parse(`${H}component _hidden [0.5, 0.5]\n`).nodes[0].id).toBe('_hidden');
  });

  it('reads a name Mermaid\'s lexer would split at a keyword, as one name (Canvas is more lenient)', () => {
    expect(parse(`${H}component notebook [0.5, 0.5]\n`).nodes[0].id).toBe('notebook');
    expect(parse(`${H}component builder [0.5, 0.5]\n`).nodes[0].id).toBe('builder');
  });

  it('refuses a name that starts with a digit', () => {
    expect(errors(`${H}component 3D [0.5, 0.5]\n`)).toHaveLength(1);
  });
});

describe('wardley maps: pipelines', () => {
  const dsl = `${H}component Kettle [0.6, 0.5] (buy)\npipeline Kettle {\n  component Electric [0.3]\n  component Gas [0.8] label [4, -5]\n}\n`;

  it('makes children named <parent>_<name> with the parent\'s visibility', () => {
    const m = parse(dsl);
    expect(m.nodes.map((n) => n.id)).toEqual(['Kettle', 'Kettle_Electric', 'Kettle_Gas']);
    const child = node(m, 'Kettle_Gas');
    expect(child).toMatchObject({ label: 'Gas', role: 'pipeline-component', containerId: '~pipeline:Kettle' });
    expect(child.wardley).toMatchObject({ visibility: 0.6, evolution: 0.8, labelOffset: { x: 4, y: -5 } });
    expect(child.position.y).toBe(node(m, 'Kettle').position.y);
    expect(m.containers).toHaveLength(1);
    expect(m.containers[0]).toMatchObject({ role: 'pipeline', attachedNodeIds: ['Kettle'] });
  });

  it('refuses a pipeline whose parent does not exist', () => {
    const e = errors(`${H}pipeline Nothing {\n  component X [0.5]\n}\n`);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/must reference an existing component/);
  });

  it('refuses an empty pipeline and an unclosed one', () => {
    expect(errors(`${H}component P [0.5, 0.5]\npipeline P {\n}\n`)[0]).toMatch(/at least one component/);
    expect(errors(`${H}component P [0.5, 0.5]\npipeline P {\n  component X [0.5]\n`)[0]).toMatch(/closing/);
  });

  it('refuses a "{" on the next line', () => {
    expect(errors(`${H}component P [0.5, 0.5]\npipeline P\n{\n  component X [0.5]\n}\n`).length).toBeGreaterThan(0);
  });

  it('refuses other statements inside a pipeline', () => {
    expect(errors(`${H}component P [0.5, 0.5]\npipeline P {\n  component X [0.5]\n  anchor Y [0.1, 0.1]\n}\n`)).toHaveLength(1);
    expect(errors(`${H}component P [0.5, 0.5]\npipeline P {\n  component X [0.5, 0.5]\n}\n`).length).toBeGreaterThan(0);
  });

  it('lays the box under the children and moves the parent onto its top edge', () => {
    const m = parse(dsl);
    const layout = computeWardleyLayout(m);
    const electric = node(m, 'Kettle_Electric').position;
    const gas = node(m, 'Kettle_Gas').position;
    expect(layout.pipelines).toHaveLength(1);
    const { box } = layout.pipelines[0];
    expect(box.x).toBe(electric.x - 15);
    expect(box.width).toBe(gas.x - electric.x + 30);
    expect(box.height).toBe(24);
    expect(box.y).toBe(electric.y - 12);
    const parent = layout.points.get('Kettle')!;
    expect(parent.x).toBe((electric.x + gas.x) / 2);
    expect(parent.y).toBeLessThan(box.y);
    expect(parent.y).toBeCloseTo(box.y - 1.6, 9);
    expect(layout.pipelineParents.has('Kettle')).toBe(true);
    // the model keeps the parent where its own coordinates put it
    expect(node(m, 'Kettle').position).toEqual(wardleyPoint(wardleyFrame(m), { visibility: 0.6, evolution: 0.5 }));
  });

  it('keeps container geometry in step with layOutPipelines and wardleyPipelineBox', () => {
    const m = parse(dsl);
    const box = wardleyPipelineBox(m, m.containers[0])!;
    expect(m.containers[0].position).toEqual({ x: box.x, y: box.y });
    expect(m.containers[0].size).toEqual({ width: box.width, height: box.height });
    m.nodes.find((n) => n.id === 'Kettle_Gas')!.position.x += 100;
    layOutPipelines(m);
    expect(m.containers[0].size!.width).toBe(box.width + 100);
  });
});

describe('wardley maps: links', () => {
  const nodes = `${H}component A [0.9, 0.5]\ncomponent B [0.5, 0.5]\n`;
  const link = (text: string) => parse(`${nodes}${text}\n`).edges;

  it('reads every arrow form', () => {
    expect(link('A -> B')[0].wardley).toEqual({ arrow: '->' });
    expect(link('A --> B')[0].wardley).toEqual({ arrow: '-->' });
    expect(link('A > B')[0].wardley).toEqual({ arrow: '>' });
    const dotted = link('A -.-> B')[0];
    expect(dotted.wardley).toEqual({ arrow: '-.->' });
    expect(dotted.lineStyle).toBe('dotted');
    expect(link('A -> B')[0].lineStyle).toBeUndefined();
    expect(link('A -> B')[0]).toMatchObject({ id: 'e1', sourceId: 'A', targetId: 'B' });
  });

  it('allows no arrow only when a name is quoted or a port separates the names', () => {
    expect(link('"A" "B"')[0]).toMatchObject({ sourceId: 'A', targetId: 'B', wardley: {} });
    expect(link('A "B"')).toHaveLength(1);
    expect(link('"A" B')).toHaveLength(1);
    expect(link('A +> B')[0].wardley).toEqual({ fromPort: '+>' });
    expect(errors(`${nodes}A B\n`)[0]).toMatch(/arrow/);
  });

  it('reads ports on either side', () => {
    expect(link('A +> -> B')[0].wardley).toEqual({ fromPort: '+>', arrow: '->' });
    expect(link('A -> B +<')[0].wardley).toEqual({ arrow: '->', toPort: '+<' });
    expect(link('A +<> B')[0].wardley).toEqual({ fromPort: '+<>' });
    expect(link('A +> -> B +<>')[0].wardley).toEqual({ fromPort: '+>', arrow: '->', toPort: '+<>' });
  });

  it('reads flow arrows with a label', () => {
    expect(link("A +'users'> B")[0].wardley).toEqual({ flowArrow: { label: 'users', flow: '+>' } });
    expect(link("A +'back'< B")[0].wardley).toEqual({ flowArrow: { label: 'back', flow: '+<' } });
    expect(link("A +'both ways'<> B")[0].wardley).toEqual({ flowArrow: { label: 'both ways', flow: '+<>' } });
  });

  it('takes a "; label" to the end of the line, comments included', () => {
    expect(link('A -> B; ships goods')[0].label).toBe('ships goods');
    expect(link('A -> B ; 50 % %% not a comment')[0].label).toBe('50 % %% not a comment');
    expect(link('A -> B %% a comment')[0].label).toBeUndefined();
  });

  it('keeps a link to a name that does not exist', () => {
    const edges = link('A -> Missing');
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe('Missing');
  });

  it('finds the ends by id, else by label (a pipeline child by its label)', () => {
    const m = parse(`${H}component P [0.6, 0.5]\npipeline P {\n  component Gas [0.8]\n}\ncomponent Q [0.3, 0.5]\nQ -> Gas\n`);
    expect(m.edges[0]).toMatchObject({ sourceId: 'Q', targetId: 'P_Gas' });
  });

  it('numbers links in text order', () => {
    expect(link('A -> B\nB -> A').map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('refuses garbage after a link', () => {
    expect(errors(`${nodes}A -> B C D 5\n`).length).toBeGreaterThan(0);
  });
});

describe('wardley maps: evolve', () => {
  it('sets the target, the last statement winning', () => {
    const m = parse(`${H}component A [0.5, 0.2]\nevolve A 0.6\nevolve A 0.8\n`);
    expect(node(m, 'A').wardley?.evolve).toBe(0.8);
  });

  it('refuses an unknown name (Canvas\'s choice; Mermaid ignores it)', () => {
    expect(errors(`${H}component A [0.5, 0.2]\nevolve B 0.6\n`)[0]).toMatch(/no component named "B"/);
  });

  it('may name a pipeline child by its label, and a component declared later', () => {
    const m = parse(`${H}evolve Gas 0.9\nevolve Later 0.7\ncomponent P [0.6, 0.5]\npipeline P {\n  component Gas [0.8]\n}\ncomponent Later [0.3, 0.3]\n`);
    expect(node(m, 'P_Gas').wardley?.evolve).toBe(0.9);
    expect(node(m, 'Later').wardley?.evolve).toBe(0.7);
  });
});

describe('wardley maps: notes, annotations, accelerators', () => {
  it('reads notes', () => {
    const m = parse(`${H}note "Remember this" [0.5, 0.5]\n`);
    expect(node(m, '~note1')).toMatchObject({ role: 'note', label: 'Remember this', position: { x: 450, y: 300 } });
    expect(errors(`${H}note unquoted [0.5, 0.5]\n`)).toHaveLength(1);
  });

  it('keeps the first annotations box', () => {
    const m = parse(`${H}annotations [0.1, 0.2]\nannotations [0.9, 0.9]\n`);
    expect(m.wardley?.annotationsBox).toEqual({ visibility: 0.1, evolution: 0.2 });
  });

  it('reads annotations with integer coordinates, which only the annotation lines allow', () => {
    const m = parse(`${H}annotations [20, 30]\nannotation 2,[50, 60] "second"\nannotation 1, [0.5, 0.5] "first"\n`);
    expect(m.wardley?.annotationsBox).toEqual({ visibility: 20, evolution: 30 });
    expect(m.nodes.map((n) => [n.id, n.wardley?.number, n.label])).toEqual([
      ['~annotation1', 2, 'second'],
      ['~annotation2', 1, 'first'],
    ]);
    expect(errors(`${H}annotation 1,[0.5, 0.5] "x"\nannotation x,[0.5, 0.5] "x"\n`).length).toBeGreaterThan(0);
  });

  it('reads accelerators and deaccelerators', () => {
    const m = parse(`${H}accelerator Cloud [0.2, 0.8]\ndeaccelerator Legacy [0.4, 0.3]\naccelerator "Open Source" [0.5, 0.5]\n`);
    expect(m.nodes.map((n) => [n.id, n.role, n.label])).toEqual([
      ['~accelerator1', 'accelerator', 'Cloud'],
      ['~deaccelerator1', 'deaccelerator', 'Legacy'],
      ['~accelerator2', 'accelerator', 'Open Source'],
    ]);
  });
});

describe('wardley maps: errors', () => {
  it('names the line of a statement it cannot read', () => {
    const result = parseWardley(`${H}component A [0.5, 0.5]\nthis is nonsense 42\n`);
    expect(isParseSuccess(result)).toBe(false);
    if (!isParseSuccess(result)) expect(result.errors[0].line).toBe(3);
  });

  it('reports every bad line', () => {
    expect(errors(`${H}component A [1, 0.5]\ncomponent B [0.5, 0.5\n`)).toHaveLength(2);
  });
});

describe('wardley maps: the serializer', () => {
  const ser = (dsl: string) => serializeWardley(parse(dsl));

  it('groups statements by kind, with a blank line between groups', () => {
    const out = ser(
      `${H}note "n" [0.5, 0.5]\nB -> A\ncomponent A [0.5, 0.5]\nanchor B [0.9, 0.5]\naccelerator X [0.1, 0.1]\nevolve A 0.9\ntitle T\n`,
    );
    expect(out).toBe(
      [
        'wardley-beta',
        'title T',
        '',
        'anchor B [0.9, 0.5]',
        '',
        'component A [0.5, 0.5]',
        '',
        'B -> A',
        '',
        'evolve A 0.9',
        '',
        'note "n" [0.5, 0.5]',
        '',
        'accelerator X [0.1, 0.1]',
        '',
      ].join('\n'),
    );
  });

  it('writes the markings of a component in the fixed order', () => {
    expect(ser(`${H}component A [0.5, 0.5] label [1, -2] (market) inertia\n`)).toContain('component A [0.5, 0.5] label [1, -2] (market) (inertia)\n');
  });

  it('writes size and evolution first', () => {
    const out = ser(`${H}evolution Alpha@0.25 / One -> Beta@1.0\nsize [1000, 700]\n`);
    expect(out).toBe(`${H}size [1000, 700]\nevolution Alpha@0.25 / One -> Beta@1.0\n`);
  });

  it('writes title and accessibility lines', () => {
    const out = ser(`${H}title T\naccTitle: A\naccDescr: D\n`);
    expect(out).toBe(`${H}title T\naccTitle: A\naccDescr: D\n`);
  });

  it('quotes names Mermaid would misread and leaves the rest bare', () => {
    for (const bare of ['Kettle', 'Two Words', 'real-time processing', 'R&D', 'byte pair (BPE)', 'A1', 'x_y']) {
      expect(wardleyName(bare), bare).toBe(bare);
    }
    for (const risky of ['notebook', 'builder', 'labelled', 'sizeable', 'market share', '3D', 'v1.2', 'a/b', 'Café', '_hidden', 'with"quote', 'title x', '', ' lead']) {
      expect(wardleyName(risky), risky).toMatch(/^".*"$/);
    }
    expect(wardleyName('with"quote')).toBe('"with\\"quote"');
    expect(wardleyName('back\\slash')).toBe('"back\\\\slash"');
  });

  it('writes numbers as decimals, never an exponent', () => {
    expect(wardleyNumber(1)).toBe('1.0');
    expect(wardleyNumber(0)).toBe('0.0');
    expect(wardleyNumber(0.5)).toBe('0.5');
    expect(wardleyNumber(35)).toBe('35.0');
    expect(wardleyNumber(1e-7)).toBe('0.0000001');
    expect(wardleyNumber(1e-7)).not.toMatch(/e/i);
    expect(wardleyNumber(1.5e-10)).not.toMatch(/e/i);
  });

  it('reads back every name it wrote, quoted or not', () => {
    const names = ['notebook', 'builder', 'Two Words', '3D', 'a.b', 'a/b', 'Café', '_x', 'with"quote', "it's", 'real-time', 'R&D'];
    const dsl = `${H}${names.map((n, i) => `component "${n.replace(/"/g, '\\"').replace(/'/g, "\\'")}" [0.5, 0.${(i % 9) + 1}]`).join('\n')}\n`;
    const m = parse(dsl);
    expect(m.nodes.map((n) => n.id)).toEqual(names);
    const again = parse(serializeWardley(m));
    expect(again.nodes.map((n) => n.id)).toEqual(names);
  });

  it('writes the links of every shape and reads them back', () => {
    const dsl =
      `${H}component A [0.9, 0.5]\ncomponent B [0.5, 0.5]\n` +
      "A -> B\nA --> B\nA > B\nA -.-> B\nA +> B\nA -> B +<>\nA +'x'> B\n\"A\" \"B\"\nA -> B; note it\n";
    const m = parse(dsl);
    const out = serializeWardley(m);
    expect(out).toContain('A -> B\nA --> B\nA > B\nA -.-> B\nA +> B\n');
    expect(out).toContain("A -> B +<>\nA +'x'> B\n");
    expect(out).toContain('"A" "B"\n');
    expect(out).toContain('A -> B; note it\n');
    expect(parse(out).edges.map((e) => e.wardley)).toEqual(m.edges.map((e) => e.wardley));
  });

  it('writes -.-> for an edge whose lineStyle is dotted, and drops it when it is not', () => {
    const m = parse(`${H}component A [0.9, 0.5]\ncomponent B [0.5, 0.5]\nA -> B\nA -.-> B\n`);
    m.edges[0] = { ...m.edges[0], lineStyle: 'dotted' };
    m.edges[1] = { ...m.edges[1], lineStyle: undefined };
    expect(serializeWardley(m)).toContain('A -.-> B\nA -> B\n');
  });

  it('writes a link to a missing name by its text', () => {
    expect(ser(`${H}component A [0.9, 0.5]\nA -> Missing\n`)).toContain('A -> Missing\n');
  });

  it('follows a renamed label in the links and in evolve', () => {
    const m = parse(`${H}component A [0.9, 0.5]\ncomponent B [0.5, 0.5]\nA -> B\nevolve B 0.8\n`);
    const renamed = { ...m, nodes: m.nodes.map((n) => (n.id === 'B' ? { ...n, label: 'Renamed' } : n)) };
    const out = serializeWardley(renamed);
    expect(out).toContain('component Renamed [0.5, 0.5]');
    expect(out).toContain('A -> Renamed\n');
    expect(out).toContain('evolve Renamed 0.8\n');
    expect(parse(out).edges[0]).toMatchObject({ sourceId: 'A', targetId: 'Renamed' });
  });

  it('writes a pipeline and its children, with the parent\'s name', () => {
    const out = ser(`${H}component P [0.6, 0.5]\npipeline P {\n  component Gas [0.8] label [4, -5]\n  component Electric [0.3]\n}\n`);
    expect(out).toContain('pipeline P {\n  component Gas [0.8] label [4, -5]\n  component Electric [0.3]\n}\n');
  });

  it('writes annotations with their numbers and the box', () => {
    const out = ser(`${H}annotations [0.1, 0.2]\nannotation 3,[0.5, 0.5] "third"\n`);
    expect(out).toContain('annotations [0.1, 0.2]\nannotation 3,[0.5, 0.5] "third"\n');
  });

  it('is stable: serialize(parse(serialize(parse(x)))) equals serialize(parse(x)) for the whole corpus', () => {
    const root = join(__dirname, '../../corpus/cases');
    const cases = readdirSync(root).filter((d) => d.startsWith('wardley-'));
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const name of cases) {
      const input = readFileSync(join(root, name, 'input.mmd'), 'utf8');
      const once = serializeWardley(parse(input));
      const twice = serializeWardley(parse(once));
      expect(twice, name).toBe(once);
      // and the model survives a round trip
      const a = parse(once);
      const b = parse(twice);
      expect(b.nodes.map((n) => n.id), name).toEqual(a.nodes.map((n) => n.id));
      expect(b.edges.length, name).toBe(a.edges.length);
    }
  });
});

describe('wardley maps: moved and unmoved nodes', () => {
  it('writes an unmoved node\'s coordinates exactly as written', () => {
    const out = serializeWardley(parse(`${H}component A [35.0, 35.0]\ncomponent B [0.350, 0.1]\nanchor C [0.90, 0.5]\n`));
    expect(out).toContain('component A [35.0, 35.0]');
    expect(out).toContain('component B [0.35, 0.1]');
    expect(out).toContain('anchor C [0.9, 0.5]');
  });

  it('writes new 0-1 coordinates, two decimals, for a moved node', () => {
    const m = parse(`${H}component A [0.5, 0.5]\ncomponent B [35.0, 35.0]\n`);
    // A to evolution 0.25 and visibility 0.75; B left alone.
    const moved = { ...m, nodes: m.nodes.map((n) => (n.id === 'A' ? { ...n, position: { x: 48 + 0.25 * 804, y: 552 - 0.75 * 504 } } : n)) };
    const out = serializeWardley(moved);
    expect(out).toContain('component A [0.75, 0.25]');
    expect(out).toContain('component B [35.0, 35.0]');
  });

  it('rounds a moved position to two decimals and keeps it inside the map', () => {
    const m = parse(`${H}component A [0.5, 0.5]\ncomponent B [0.5, 0.5]\n`);
    const moved = {
      ...m,
      nodes: [
        { ...m.nodes[0], position: { x: 48 + 0.3333 * 804, y: 552 - 0.6666 * 504 } },
        { ...m.nodes[1], position: { x: -500, y: 5000 } },
      ],
    };
    const out = serializeWardley(moved);
    expect(out).toContain('component A [0.67, 0.33]');
    expect(out).toContain('component B [0.0, 0.0]');
  });

  it('computes moved coordinates from the written size', () => {
    const m = parse(`${H}size [1100, 800]\ncomponent A [0.5, 0.5]\n`);
    // chart is 1004 x 704, so evolution 0.2 is x = 48 + 200.8 and visibility 0.9 is y = 752 - 633.6
    const moved = { ...m, nodes: [{ ...m.nodes[0], position: { x: 48 + 0.2 * 1004, y: 752 - 0.9 * 704 } }] };
    expect(serializeWardley(moved)).toContain('component A [0.9, 0.2]');
    expect(serializeWardley(moved)).toContain('size [1100, 800]');
  });

  it('writes a new evolution for a pipeline child moved horizontally, and keeps an unmoved one', () => {
    const m = parse(`${H}component P [0.6, 0.5]\npipeline P {\n  component Gas [35.0]\n  component Electric [0.3]\n}\n`);
    const moved = {
      ...m,
      nodes: m.nodes.map((n) => (n.id === 'P_Electric' ? { ...n, position: { x: 48 + 0.1 * 804, y: n.position.y } } : n)),
    };
    const out = serializeWardley(moved);
    expect(out).toContain('component Gas [35.0]');
    expect(out).toContain('component Electric [0.1]');
  });

  it('serializes a node added with no wardley data as a component at its position', () => {
    const m = parse(`${H}component A [0.5, 0.5]\n`);
    const added = addNode(m, { shape: 'circle', label: 'Fresh' });
    const placed = { ...added, nodes: added.nodes.map((n) => (n.label === 'Fresh' ? { ...n, position: { x: 48 + 0.5 * 804, y: 552 - 0.25 * 504 } } : n)) };
    const out = serializeWardley(placed);
    expect(out).toContain('component Fresh [0.25, 0.5]\n');
    expect(parse(out).nodes.map((n) => n.id)).toEqual(['A', 'Fresh']);
  });

  it('positions every node again from its coordinates', () => {
    const m = parse(`${H}size [1100, 800]\ncomponent P [0.6, 0.5]\npipeline P {\n  component Gas [0.8]\n}\n`);
    const shifted = { ...m, nodes: m.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })) };
    const back = wardleyPositionsFromCoordinates(shifted);
    expect(back.nodes.map((n) => n.position)).toEqual(m.nodes.map((n) => n.position));
    expect(back.containers[0].size).toEqual(m.containers[0].size);
  });
});

describe('wardley maps: portable export', () => {
  it('writes the map again, so a leniently read name goes out quoted', () => {
    const out = toPortableMermaid(`${H}component notebook [0.5, 0.5]\ncomponent Plain [0.4, 0.4]\n`, { stripFrontMatter: true });
    expect(out).toContain('component "notebook" [0.5, 0.5]');
    expect(out).toContain('component Plain [0.4, 0.4]');
    expect(out.startsWith('wardley-beta')).toBe(true);
    expect(out).not.toContain('---');
  });

  it('hands back text it cannot read as it is', () => {
    const bad = `${H}component A [1, 1]\n`;
    expect(toPortableMermaid(bad, { stripFrontMatter: true })).toBe(bad);
  });
});

describe('wardley maps: drawing', () => {
  const dsl = (body: string) => `${H}${body}\n`;

  it('draws the title and the four default stage labels', () => {
    const out = svg(dsl('title Tea Shop\ncomponent A [0.5, 0.5]'));
    expect(out).toContain('class="wardley-title"');
    expect(out).toMatch(/>Tea Shop<\/text>/);
    for (const label of ['Genesis', 'Custom Built', 'Product', 'Commodity', 'Evolution', 'Visibility']) expect(out).toContain(`>${label}</text>`);
    expect(out).toContain('width="900" height="600" viewBox="0 0 900 600"');
  });

  it('draws custom stage labels and dividers only at boundaries when every stage has one', () => {
    const withBounds = svg(dsl('evolution A@0.3 -> B@0.6 / Beta -> C@1.0'));
    expect(withBounds).toContain('>A</text>');
    expect(withBounds).toContain('>B / Beta</text>');
    expect(withBounds).not.toContain('>Genesis</text>');
    const dividers = withBounds.match(/<line x1="([\d.]+)" x2="\1" y1="48" y2="552" stroke="#000" stroke-width="1" stroke-dasharray="5 5"/g) ?? [];
    expect(dividers).toHaveLength(2);
    expect(withBounds).toContain(`x1="${48 + 0.3 * 804}" x2="${48 + 0.3 * 804}"`);
    expect(withBounds).toContain(`x1="${48 + 0.6 * 804}" x2="${48 + 0.6 * 804}"`);
    const layout = computeWardleyLayout(parse(dsl('evolution A@0.3 -> B@0.6 -> C@1.0')));
    expect(layout.stages).toEqual([
      { label: 'A', start: 0, end: 0.3 },
      { label: 'B', start: 0.3, end: 0.6 },
      { label: 'C', start: 0.6, end: 1.0 },
    ]);
  });

  it('spaces the stages evenly when a boundary is missing', () => {
    const layout = computeWardleyLayout(parse(dsl('evolution A@0.3 -> B -> C@1.0')));
    expect(layout.stages.map((s) => [s.start, s.end])).toEqual([
      [0, 1 / 3],
      [1 / 3, 2 / 3],
      [2 / 3, 1],
    ]);
    const defaults = computeWardleyLayout(parse(H));
    expect(defaults.stages.map((s) => s.label)).toEqual(['Genesis', 'Custom Built', 'Product', 'Commodity']);
    expect(defaults.stages.map((s) => s.start)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('draws a component as a circle at the projected centre', () => {
    const out = svg(dsl('component Cup [0.5, 0.25]'));
    expect(out).toContain('<circle cx="249" cy="300" r="6" fill="#fff" stroke="#000" stroke-width="1" />');
    expect(out).toContain('x="257" y="292" fill="#222" font-size="10" text-anchor="start">Cup</text>');
  });

  it('uses the label offset for the text', () => {
    expect(svg(dsl('component Cup [0.5, 0.25] label [-20, 15]'))).toContain('x="229" y="315"');
  });

  it('draws an anchor as bold text with no circle', () => {
    const out = svg(dsl('anchor Customer [0.9, 0.5]'));
    expect(out).toMatch(/font-weight="bold" text-anchor="middle" dominant-baseline="middle">Customer<\/text>/);
    expect(out).not.toContain('<circle');
  });

  it('draws a ring per strategy, behind the circle', () => {
    const ring = (strategy: string) => svg(dsl(`component A [0.5, 0.5] (${strategy})`));
    expect(ring('outsource')).toContain('r="12" fill="#666"');
    expect(ring('buy')).toContain('r="12" fill="#ccc"');
    expect(ring('build')).toContain('r="12" fill="#eee"');
    const build = ring('build');
    expect(build.indexOf('r="12"')).toBeLessThan(build.indexOf('r="6"'));
  });

  it('draws a market as a ring and a triangle of circles, with no plain circle', () => {
    const out = svg(dsl('component A [0.5, 0.5] (market)'));
    expect(out).toContain('r="12" fill="white"');
    expect(out).not.toContain('r="6" fill="#fff"');
    expect(count(out, 'r="4.199999999999999"') + count(out, /r="4\.2\d*" fill="white" stroke="#000" stroke-width="2"/g)).toBe(3);
    expect(count(out, /<line x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke="#000" stroke-width="1" \/>/g)).toBe(3);
  });

  it('draws an inertia bar beside the component, further out when there is a ring', () => {
    const plain = svg(dsl('component A [0.5, 0.5] inertia'));
    expect(plain).toContain('<line x1="471" y1="294" x2="471" y2="306" stroke="#000" stroke-width="6" />');
    const ringed = svg(dsl('component A [0.5, 0.5] (buy) inertia'));
    expect(ringed).toContain('x1="487" y1="294" x2="487" y2="306" stroke="#000" stroke-width="6"');
    expect(ringed).toContain('x="468" y="282"'); // label moved clear of the ring
  });

  it('draws a pipeline: a box, a dashed line between children, and the parent as a square on the top edge', () => {
    const dslText = dsl('component P [0.6, 0.5]\npipeline P {\n  component A [0.3]\n  component B [0.8]\n}');
    const out = svg(dslText);
    const layout = computeWardleyLayout(parse(dslText));
    const { box } = layout.pipelines[0];
    expect(out).toContain(`<rect class="wardley-pipeline" data-id="~pipeline:P" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="#000" stroke-width="1.5" rx="4" ry="4" />`);
    const parent = layout.points.get('P')!;
    expect(parent.y).toBeLessThan(box.y);
    const side = 6 * 1.6;
    expect(out).toContain(`<rect x="${parent.x - side / 2}" y="${parent.y - side / 2}" width="${side}" height="${side}" fill="#fff"`);
    // the parent has the square, not a circle, at its own coordinates
    expect(out).not.toMatch(new RegExp(`<circle cx="${parent.x}" cy="${parent.y}"`));
    expect(out).toMatch(/stroke-dasharray="4 4" \/>/);
    // children are circles on the box's middle line
    const m = parse(dslText);
    const a = node(m, 'P_A').position;
    expect(out).toContain(`<circle cx="${a.x}" cy="${a.y}" r="6"`);
  });

  it('stops a link at the circles', () => {
    const out = svg(dsl('component A [0.9, 0.5]\ncomponent B [0.5, 0.5]\nA -> B'));
    // both at x = 450; A at y = 552 - 453.6 = 98.4, B at y = 300
    expect(out).toMatch(/<line class="wardley-link" data-id="e1" x1="450" y1="104\.39\d*" x2="450" y2="294"/);
    expect(out).not.toContain('marker-end');
  });

  it('stops a link at the pipeline parent\'s square by its half diagonal', () => {
    const layout = computeWardleyLayout(parse(dsl('component P [0.9, 0.5]\npipeline P {\n  component A [0.4]\n}\ncomponent Q [0.2, 0.5]\nQ -> P')));
    const p = layout.points.get('P')!;
    const q = layout.points.get('Q')!;
    const radius = (6 * 1.6) / Math.SQRT2;
    const out = svg(dsl('component P [0.9, 0.5]\npipeline P {\n  component A [0.4]\n}\ncomponent Q [0.2, 0.5]\nQ -> P'));
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    expect(out).toContain(`x2="${p.x + (-dx / d) * radius}" y2="${p.y + (-dy / d) * radius}"`);
  });

  it('draws flow arrowheads by port', () => {
    const body = 'component A [0.9, 0.5]\ncomponent B [0.5, 0.5]\n';
    expect(svg(dsl(`${body}A +> B`))).toMatch(/data-id="e1"[^>]*marker-end="url\(#wardley-flow-end\)"/);
    const back = svg(dsl(`${body}A -> B +<`));
    expect(back).toMatch(/data-id="e1"[^>]*marker-start="url\(#wardley-flow-start\)"/);
    expect(back).not.toMatch(/data-id="e1"[^>]*marker-end/);
    const both = svg(dsl(`${body}A +<> B`));
    expect(both).toMatch(/data-id="e1"[^>]*marker-end="url\(#wardley-flow-end\)" marker-start="url\(#wardley-flow-start\)"/);
    expect(svg(dsl(`${body}A +'users'> B`))).toMatch(/data-id="e1"[^>]*marker-end/);
  });

  it('draws a dotted link dashed and a labelled link with rotated text', () => {
    const body = 'component A [0.9, 0.5]\ncomponent B [0.5, 0.8]\n';
    expect(svg(dsl(`${body}A -.-> B`))).toMatch(/data-id="e1"[^>]*stroke-dasharray="6 6"/);
    expect(svg(dsl(`${body}A -> B`))).not.toMatch(/data-id="e1"[^>]*stroke-dasharray/);
    const labelled = svg(dsl(`${body}A -> B; supplies <tea> & milk`));
    expect(labelled).toMatch(/text-anchor="middle" dominant-baseline="middle" transform="rotate\(-?[\d.]+ [\d.]+ [\d.]+\)">supplies &lt;tea&gt; &amp; milk<\/text>/);
    expect(svg(dsl(`${body}A +'users'> B`))).toContain('>users</text>');
  });

  it('does not draw a link to a missing name', () => {
    expect(svg(dsl('component A [0.9, 0.5]\nA -> Missing'))).not.toContain('class="wardley-link"');
  });

  it('does not draw a link from a pipeline component to its parent', () => {
    const out = svg(dsl('component P [0.6, 0.5]\npipeline P {\n  component A [0.3]\n}\nP_A -> P'));
    expect(out).not.toContain('class="wardley-link"');
    const other = svg(dsl('component P [0.6, 0.5]\npipeline P {\n  component A [0.3]\n}\nP -> P_A'));
    expect(other).toContain('class="wardley-link"');
  });

  it('draws an evolve arrow, red and dashed, to the target x', () => {
    const out = svg(dsl('component A [0.5, 0.2]\nevolve A 0.8'));
    const x1 = 48 + 0.2 * 804;
    const target = 48 + 0.8 * 804;
    expect(out).toContain(`<line class="wardley-evolve" x1="${x1}" y1="300" x2="${target - 8}" y2="300" stroke="#dc3545" stroke-width="1" stroke-dasharray="4 4" marker-end="url(#wardley-evolve-arrow)" />`);
  });

  it('draws numbered annotation circles and the box sorted by number', () => {
    const out = svg(dsl('annotations [0.1, 0.2]\nannotation 2,[0.5, 0.5] "second"\nannotation 1,[0.4, 0.4] "first"'));
    expect(count(out, '<g class="wardley-annotation" ')).toBe(2);
    expect(out).toContain('r="10" fill="white" stroke="#000" stroke-width="1.5"');
    expect(out).toContain('<g class="wardley-annotations-box">');
    expect(out.indexOf('>1. first<')).toBeGreaterThan(-1);
    expect(out.indexOf('>1. first<')).toBeLessThan(out.indexOf('>2. second<'));
  });

  it('draws no annotation box without an annotations line', () => {
    const out = svg(dsl('annotation 1,[0.4, 0.4] "first"'));
    expect(out).toContain('class="wardley-annotation"');
    expect(out).not.toContain('wardley-annotations-box');
  });

  it('draws notes as bold text at their point', () => {
    const out = svg(dsl('note "Look here" [0.5, 0.5]'));
    expect(out).toContain('x="450" y="300" text-anchor="start" font-size="11" fill="#222" font-weight="bold">Look here</text>');
  });

  it('draws accelerators and deaccelerators as block arrows pointing opposite ways', () => {
    const out = svg(dsl('accelerator Up [0.5, 0.5]\ndeaccelerator Down [0.4, 0.4]'));
    expect(out).toContain('<g class="wardley-accelerator"');
    expect(out).toContain('<g class="wardley-deaccelerator"');
    expect(out).toContain('d="M 450 285 L 490 285 L 490 277 L 510 300 L 490 323 L 490 315 L 450 315 Z"');
    const x = 48 + 0.4 * 804;
    const y = 552 - 0.4 * 504;
    expect(out).toContain(`d="M ${x + 60} ${y - 15} L ${x + 20} ${y - 15} L ${x + 20} ${y - 23} L ${x} ${y} L ${x + 20} ${y + 23} L ${x + 20} ${y + 15} L ${x + 60} ${y + 15} Z"`);
    expect(out).toContain('>Up</text>');
    expect(out).toContain('>Down</text>');
  });

  it('escapes names and the title', () => {
    const out = svg(dsl('title A & <B>\ncomponent "x<y" [0.5, 0.5]'));
    expect(out).toContain('A &amp; &lt;B&gt;');
    expect(out).toContain('>x&lt;y</text>');
  });

  it('draws a custom size', () => {
    expect(svg(dsl('size [1100, 800]'))).toContain('width="1100" height="800" viewBox="0 0 1100 800"');
  });

  it('is routed from renderToSvg by the diagram type, and a flowchart is not', () => {
    expect(svg(dsl('component A [0.5, 0.5]'))).toContain('class="wardley-map"');
    const m = parse(dsl('component A [0.5, 0.5]'));
    expect(renderToSvg({ ...m, diagramTypeId: 'flowchart' })).not.toContain('class="wardley-map"');
  });
});
