// canvas-8uh1.6: frames -- other diagrams drawn over a diagram (front matter `canvas.frames`, every family).
import { describe, expect, it } from 'vitest';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { toPortableMermaid, FRAMES_NOTE } from '../../src/dsl/portable-mermaid.js';
import { addFrame, nextFrameId, removeFrame, updateFrame } from '../../src/model/diagram-ops.js';
import { renderToSvg } from '../../src/render/svg-renderer.js';
import { frameTitle } from '../../src/render/frames-render.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

const SAMPLES: Record<string, string> = {
  flowchart: 'flowchart TD\n  A --> B\n',
  c4: 'C4Context\n  System(pay, "Payments")\n',
  erd: 'erDiagram\n  A ||--o{ B : has\n',
  uml: 'classDiagram\n  class Order\n',
  architecture: 'architecture-beta\n  service api(server)[API]\n',
  state: 'stateDiagram-v2\n  [*] --> Idle\n',
  sequence: 'sequenceDiagram\n  participant API\n  API->>API: tick\n',
  wardley: 'wardley-beta\ncomponent Tea [0.5, 0.5]\n',
};
const parse = (family: string, text: string): DiagramModel => {
  const result = getDslFamily(family)!.parse(text);
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
};
const save = (family: string, model: DiagramModel) => getDslFamily(family)!.serialize(model);
const FRAME_FM = (entries: string) => `---\ncanvas:\n  frames:\n${entries}---\n`;
const entry = (id: string, diagramId: string, x: unknown, y: unknown, w: unknown, h: unknown) =>
  `    - id: ${id}\n      diagramId: ${diagramId}\n      x: ${x}\n      y: ${y}\n      width: ${w}\n      height: ${h}\n`;

describe('frames in the front matter', () => {
  for (const [family, text] of Object.entries(SAMPLES)) {
    it(`${family}: read, saved and read back unchanged; bad entries dropped`, () => {
      const fm = FRAME_FM(entry('f1', 'd-1', 10, 20, 300, 200) + entry('f1', 'd-2', 0, 0, 5, 5) + entry('f2', 'bad id!', 0, 0, 5, 5) + entry('f3', 'd-3', 0, 0, 0, 5) + entry('f4', 'd-4', 'x', 0, 5, 5));
      const model = parse(family, fm + text);
      expect(model.frames).toEqual([{ id: 'f1', diagramId: 'd-1', position: { x: 10, y: 20 }, size: { width: 300, height: 200 } }]);
      const saved = save(family, model);
      expect(parse(family, saved).frames).toEqual(model.frames);
      expect(save(family, parse(family, saved))).toBe(saved);
      expect(save(family, parse(family, text))).not.toContain('frames:');
    });
  }
});

describe('frame edits', () => {
  const base = parse('flowchart', SAMPLES.flowchart);
  it('adds with the next free id, a default place and size, never below the minimum', () => {
    const one = addFrame(base, { diagramId: 'd-1' });
    expect(one.frames).toEqual([{ id: 'f1', diagramId: 'd-1', position: { x: 40, y: 40 }, size: { width: 360, height: 240 } }]);
    const two = addFrame(one, { diagramId: 'd-2', position: { x: 500, y: 10 }, size: { width: 50, height: 900 } });
    expect(two.frames![1]).toEqual({ id: 'f2', diagramId: 'd-2', position: { x: 500, y: 10 }, size: { width: 160, height: 900 } });
    expect(nextFrameId(removeFrame(two, 'f1'))).toBe('f1');
    expect(() => addFrame(base, { diagramId: 'bad id' })).toThrow('not a diagram id');
  });
  it('moves, resizes and repoints; the last removal drops frames', () => {
    const two = addFrame(addFrame(base, { diagramId: 'd-1' }), { diagramId: 'd-2' });
    const moved = updateFrame(two, 'f1', { position: { x: 1, y: 2 }, size: { width: 10, height: 10 } });
    expect(moved.frames![0]).toMatchObject({ position: { x: 1, y: 2 }, size: { width: 160, height: 100 } });
    expect(updateFrame(two, 'f2', { diagramId: 'd-9' }).frames![1].diagramId).toBe('d-9');
    expect(() => updateFrame(two, 'f9', {})).toThrow('no frame');
    expect('frames' in removeFrame(removeFrame(two, 'f1'), 'f2')).toBe(false);
    expect(removeFrame(two, 'nope')).toBe(two);
  });
});

describe('drawing frames', () => {
  const framed = addFrame(parse('flowchart', SAMPLES.flowchart), { diagramId: 'd-1', position: { x: 600, y: 40 } });
  const inner = renderToSvg(parse('flowchart', 'flowchart TD\n  X[Inner shape]\n'));

  it("draws the inner diagram's drawing under its title, and grows the drawing to fit", () => {
    const svg = renderToSvg(framed, undefined, { frameContents: { 'd-1': { name: 'Payments containers', status: 'available', svg: inner } } });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="980" height="300" viewBox="0 0 980 300">/);
    expect(svg).toContain('data-frame-id="f1"');
    expect(svg).toContain('>Payments containers</text>');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(svg).toContain('Inner shape');
  });

  it('a frame it cannot show is a placeholder that says why', () => {
    expect(renderToSvg(framed, undefined, { frameContents: { 'd-1': { status: 'deleted' } } })).toContain('Deleted (in the bin)');
    expect(renderToSvg(framed, undefined, { frameContents: { 'd-1': { status: 'unavailable' } } })).toContain('Not available');
    expect(renderToSvg(framed, undefined, { frameContents: { 'd-1': { status: 'missing' } } })).toContain('Diagram no longer exists');
    // Not handed in at all (a frame inside a framed diagram): a titled placeholder, one level deep.
    expect(renderToSvg(framed)).toContain('>Embedded diagram</text>');
  });

  it('opens its diagram with a link base; a long title is shortened', () => {
    expect(renderToSvg(framed, undefined, { diagramLinkBase: 'https://c.example/?diagramId=' })).toContain('<a href="https://c.example/?diagramId=d-1"><g class="diagram-frame"');
    expect(frameTitle({ status: 'available', name: 'x'.repeat(100) }, 160)).toBe(`${'x'.repeat(19)}…`);
  });

  it('every family draws its frames', () => {
    for (const [family, text] of Object.entries(SAMPLES)) {
      const svg = renderToSvg(addFrame(parse(family, text), { diagramId: 'd-1' }));
      expect(svg, family).toContain('class="diagram-frame"');
    }
  });
});

it('the Mermaid export leaves frames out and says so', () => {
  const text = save('flowchart', addFrame(parse('flowchart', SAMPLES.flowchart), { diagramId: 'd-1' }));
  for (const stripFrontMatter of [true, false]) expect(toPortableMermaid(text, { stripFrontMatter })).toMatch(new RegExp(`${FRAMES_NOTE.replace(/[.()]/g, '\\$&')}\\n$`));
  expect(toPortableMermaid(SAMPLES.flowchart)).not.toContain('Canvas frames');
});
