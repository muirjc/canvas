// canvas-y2yf: connectors that join the same two shapes get their own lanes; a connector back to the same
// shape is a loop. Shared by both renderers and the canvas.
import { describe, expect, it } from 'vitest';
import type { DiagramEdge, DiagramModel, DiagramNode } from '../../src/model/diagram-model.js';
import { edgeLanes, laneShift, PARALLEL_EDGE_GAP, renderToSvg, selfLoopGeometry } from '../../src/render/svg-renderer.js';

const box = (id: string, x: number): DiagramNode => ({ id, label: id, shape: 'rectangle', position: { x, y: 0 }, size: { width: 100, height: 60 } });
const edge = (id: string, sourceId: string, targetId: string, label?: string): DiagramEdge => ({ id, sourceId, targetId, ...(label ? { label } : {}) });
const lines = (svg: string) => [...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/g)].map((m) => m.slice(1).map(Number));

describe('parallel connectors', () => {
  it('a pair is the same either way round; a lone connector has one lane', () => {
    const lanes = edgeLanes([edge('e1', 'a', 'b'), edge('e2', 'b', 'a'), edge('e3', 'a', 'c'), edge('e4', 'a', 'a'), edge('e5', 'a', 'a')]);
    expect(lanes.get('e1')).toEqual({ index: 0, count: 2 });
    expect(lanes.get('e2')).toEqual({ index: 1, count: 2 });
    expect(lanes.get('e3')).toEqual({ index: 0, count: 1 });
    expect(lanes.get('e5')).toEqual({ index: 1, count: 2 });
  });

  it('A->B and B->A move apart, by the gap, perpendicular to the line', () => {
    const size = { width: 100, height: 60 };
    const from = { x: 50, y: 30 };
    const to = { x: 350, y: 30 };
    const one = laneShift(edge('e1', 'a', 'b'), { index: 0, count: 2 }, from, to, size, size);
    const two = laneShift(edge('e2', 'b', 'a'), { index: 1, count: 2 }, to, from, size, size);
    expect([Math.abs(one.x), one.y]).toEqual([0, -PARALLEL_EDGE_GAP / 2]);
    expect([Math.abs(two.x), two.y]).toEqual([0, PARALLEL_EDGE_GAP / 2]);
    expect(laneShift(edge('e1', 'a', 'b'), { index: 0, count: 1 }, from, to, size, size)).toEqual({ x: 0, y: 0 });
  });

  it('many connectors squeeze to stay within the shapes', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [box('a', 0), box('b', 300)],
      edges: Array.from({ length: 11 }, (_, i) => edge(`e${i}`, 'a', 'b')),
      containers: [],
    };
    const ys = lines(renderToSvg(model)).map(([, y1]) => y1);
    expect(new Set(ys).size).toBe(11);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(60);
  });

  it('a connector back to the same shape is a loop, with its label beside it', () => {
    const model: DiagramModel = { diagramTypeId: 'flowchart', nodes: [box('a', 0)], edges: [edge('e1', 'a', 'a', 'retry')], containers: [] };
    const svg = renderToSvg(model);
    const loop = selfLoopGeometry({ x: 0, y: 0 }, { width: 100, height: 60 }, 0);
    expect(svg).toContain(`<path d="${loop.path}" fill="none" stroke="#333333" marker-end="url(#arrowhead)" />`);
    expect(svg).toContain('>retry</text>');
    expect(selfLoopGeometry({ x: 0, y: 0 }, { width: 100, height: 60 }, 1).path).not.toBe(loop.path);
  });
});
