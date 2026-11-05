// canvas-xpuk: connector labels stay clear of each other and of the shapes they join.
import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { parseState } from '../../src/dsl/state.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { autoLayout } from '../../src/model/auto-layout.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { edgeLabelPlacement, renderToSvg, selfLoopGeometry } from '../../src/render/svg-renderer.js';

function model(result: ReturnType<typeof parseState>): DiagramModel {
  if (!isParseSuccess(result)) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const texts = (svg: string) =>
  [...svg.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*text-anchor="([^"]+)"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), anchor: m[3], text: m[4] }));

describe('edgeLabelPlacement', () => {
  const mid = { x: 100, y: 50 };
  it('no shift keeps the label centred just above the point', () => {
    expect(edgeLabelPlacement(mid, { x: 0, y: 0 })).toEqual({ x: 100, y: 46, anchor: 'middle' });
  });
  it('a vertical pair puts labels on their own outer sides', () => {
    expect(edgeLabelPlacement(mid, { x: 9, y: 0 })).toEqual({ x: 106, y: 54, anchor: 'start' });
    expect(edgeLabelPlacement(mid, { x: -9, y: 0 })).toEqual({ x: 94, y: 54, anchor: 'end' });
  });
  it('a horizontal pair puts labels above and below', () => {
    expect(edgeLabelPlacement(mid, { x: 0, y: -9 })).toEqual({ x: 100, y: 42, anchor: 'middle' });
    expect(edgeLabelPlacement(mid, { x: 0, y: 9 })).toEqual({ x: 100, y: 66, anchor: 'middle' });
  });
  it('a diagonal pair goes beside the line when it leans sideways enough', () => {
    const n = Math.SQRT1_2;
    const p = edgeLabelPlacement(mid, { x: n * 9, y: n * 9 });
    expect(p.anchor).toBe('start');
    expect(p.x).toBeCloseTo(100 + n * 6);
    expect(p.y).toBeCloseTo(50 + n * 6 + 4);
  });
});

describe('connector labels as drawn', () => {
  it('opposite connectors between two states label on opposite sides', () => {
    const m = model(parseState('stateDiagram-v2\n  A --> B : go\n  B --> A : back\n'));
    const placed: DiagramModel = {
      ...m,
      nodes: m.nodes.map((n) => ({ ...n, position: { x: 0, y: n.id === 'A' ? 0 : 200 } })),
    };
    const labels = texts(renderToSvg(placed));
    const go = labels.find((t) => t.text === 'go')!;
    const back = labels.find((t) => t.text === 'back')!;
    expect(new Set([go.anchor, back.anchor])).toEqual(new Set(['end', 'start']));
    expect(go.x).not.toBe(back.x);
  });

  it('a lone connector keeps its centred label just above the middle', () => {
    const r = parseFlowchart('graph LR\n  A --> B\n');
    const m = model(r);
    const lone: DiagramModel = { ...m, edges: m.edges.map((e) => ({ ...e, label: 'go' })) };
    const svg = renderToSvg(lone);
    const line = svg.match(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/)!.slice(1).map(Number);
    const a = lone.nodes.find((n) => n.id === 'A')!;
    const b = lone.nodes.find((n) => n.id === 'B')!;
    const midY = (a.position.y + (a.size?.height ?? 60) / 2 + b.position.y + (b.size?.height ?? 60) / 2) / 2;
    const label = texts(svg).find((t) => t.text === 'go')!;
    expect(label.anchor).toBe('middle');
    expect(label.y).toBe(midY - 4);
    expect(line).toHaveLength(4);
  });

  it('a connector to a composite state labels the middle of the line as drawn', () => {
    const m = autoLayout(model(parseState('stateDiagram-v2\n  state S {\n    [*] --> X\n  }\n  Y --> S : enter\n')), undefined, 'state');
    const svg = renderToSvg(m);
    const edge = m.edges.find((e) => e.label === 'enter')!;
    const g = svg.match(new RegExp(`<g data-edge-id="${edge.id}"><line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"`))!;
    const [y1, y2] = [Number(g[2]), Number(g[4])];
    const label = texts(svg).find((t) => t.text === 'enter')!;
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    expect(label.y).toBeGreaterThanOrEqual(lo - 4 - 1e-9);
    expect(label.y).toBeLessThanOrEqual(hi + 1e-9);
    // And clearly not at the composite's own centre.
    const s = m.containers.find((c) => c.id === 'S')!;
    const centreY = s.position.y + (s.size?.height ?? 0) / 2;
    expect(Math.abs(label.y - centreY)).toBeGreaterThan(Math.abs(label.y - (y1 + y2) / 2));
  });
});

describe('selfLoopGeometry on big and small boxes', () => {
  it('a big box keeps the loop at its top-right corner', () => {
    const { path } = selfLoopGeometry({ x: 10, y: 20 }, { width: 400, height: 300 }, 0);
    expect(path.startsWith('M 370 20 ')).toBe(true);
    expect(path.endsWith('410 60')).toBe(true);
  });
  it('a small box is unchanged', () => {
    const { path } = selfLoopGeometry({ x: 10, y: 20 }, { width: 120, height: 60 }, 0);
    expect(path.startsWith('M 100 20 ')).toBe(true);
    expect(path.endsWith('130 35')).toBe(true);
  });
});
