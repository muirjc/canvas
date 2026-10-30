import { describe, expect, it } from 'vitest';
import { autoLayout } from '../../src/model/auto-layout.js';
import { createEmptyDiagramModel, type DiagramModel } from '../../src/model/diagram-model.js';
import { nodeSize } from '../../src/render/svg-renderer.js';

/**
 * canvas-esn: dagre-based Auto Layout; canvas-p2g8.1 made it compound (inside groups too) and
 * extended it to C4, ERD, UML and architecture. Assertions are geometric relationships (rank
 * order, enclosure, no overlap), never exact pixels.
 */

function chainModel(): DiagramModel {
  return {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'b', label: 'B', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'c', label: 'C', shape: 'rectangle', position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e1', sourceId: 'a', targetId: 'b' },
      { id: 'e2', sourceId: 'b', targetId: 'c' },
    ],
    containers: [],
  };
}

function diamondModel(): DiagramModel {
  return {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'b', label: 'B', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'c', label: 'C', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'd', label: 'D', shape: 'rectangle', position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e1', sourceId: 'a', targetId: 'b' },
      { id: 'e2', sourceId: 'a', targetId: 'c' },
      { id: 'e3', sourceId: 'b', targetId: 'd' },
      { id: 'e4', sourceId: 'c', targetId: 'd' },
    ],
    containers: [],
  };
}

/** One top-level container ("g1") with two members at known relative offsets, plus a top-level
 *  node "x" with an edge into a member of g1 — this is what actually forces dagre to move g1
 *  (an isolated container/node with no edges could legally stay wherever dagre's origin lands). */
function containerModel(): DiagramModel {
  return {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'x', label: 'X', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'inA', label: 'InA', shape: 'rectangle', position: { x: 20, y: 20 }, containerId: 'g1' },
      { id: 'inB', label: 'InB', shape: 'rectangle', position: { x: 120, y: 60 }, containerId: 'g1' },
    ],
    edges: [{ id: 'e1', sourceId: 'x', targetId: 'inA' }],
    containers: [{ id: 'g1', label: 'Group', position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }],
  };
}

describe('autoLayout: linear chain', () => {
  it('TD: lays out B below A and C below B', () => {
    const result = autoLayout(chainModel(), 'TD');
    const a = result.nodes.find((n) => n.id === 'a')!.position;
    const b = result.nodes.find((n) => n.id === 'b')!.position;
    const c = result.nodes.find((n) => n.id === 'c')!.position;
    expect(b.y).toBeGreaterThan(a.y);
    expect(c.y).toBeGreaterThan(b.y);
    expect(b.x).toBeCloseTo(a.x, 0);
    expect(c.x).toBeCloseTo(b.x, 0);
  });

  it('LR: lays out B to the right of A and C to the right of B', () => {
    const result = autoLayout(chainModel(), 'LR');
    const a = result.nodes.find((n) => n.id === 'a')!.position;
    const b = result.nodes.find((n) => n.id === 'b')!.position;
    const c = result.nodes.find((n) => n.id === 'c')!.position;
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.x).toBeGreaterThan(b.x);
    expect(b.y).toBeCloseTo(a.y, 0);
    expect(c.y).toBeCloseTo(b.y, 0);
  });
});

describe('autoLayout: diamond', () => {
  it('TD: B and C share a rank between A and D, horizontally centered around the A/D axis', () => {
    const result = autoLayout(diamondModel(), 'TD');
    const a = result.nodes.find((n) => n.id === 'a')!.position;
    const b = result.nodes.find((n) => n.id === 'b')!.position;
    const c = result.nodes.find((n) => n.id === 'c')!.position;
    const d = result.nodes.find((n) => n.id === 'd')!.position;

    expect(b.y).toBeCloseTo(c.y, 0);
    expect(b.y).toBeGreaterThan(a.y);
    expect(b.y).toBeLessThan(d.y);
    expect(c.y).toBeGreaterThan(a.y);
    expect(c.y).toBeLessThan(d.y);

    // A and D are horizontally centered relative to B and C.
    const midBC = (b.x + c.x) / 2;
    expect(a.x).toBeCloseTo(midBC, 0);
    expect(d.x).toBeCloseTo(midBC, 0);
  });
});

describe('autoLayout: direction resolution', () => {
  it('uses the explicit direction argument when given', () => {
    const model = chainModel();
    model.direction = 'LR';
    const result = autoLayout(model, 'TD');
    expect(result.direction).toBe('TD');
  });

  it('falls back to model.direction when no explicit argument is given', () => {
    const model = chainModel();
    model.direction = 'LR';
    const result = autoLayout(model);
    expect(result.direction).toBe('LR');
  });

  it('falls back to TD when neither an explicit argument nor model.direction is set', () => {
    const model = chainModel();
    delete model.direction;
    const result = autoLayout(model);
    expect(result.direction).toBe('TD');
  });

  it('always sets the returned model\'s direction to the resolved value', () => {
    const result = autoLayout(chainModel(), 'RL');
    expect(result.direction).toBe('RL');
  });
});

// canvas-p2g8.1: Auto Layout now arranges INSIDE groups too, and sizes each group to fit.
type Box = { x: number; y: number; width: number; height: number };
const nodeBox = (m: DiagramModel, id: string): Box => {
  const n = m.nodes.find((node) => node.id === id)!;
  const { width, height } = nodeSize(n);
  return { ...n.position, width, height };
};
const groupBox = (m: DiagramModel, id: string): Box => {
  const c = m.containers.find((container) => container.id === id)!;
  return { ...c.position, ...c.size! };
};
const encloses = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('autoLayout: containers (compound)', () => {
  it('lays out a group\'s own members, sizes the group to enclose them, and keeps membership', () => {
    const model = containerModel();
    model.edges.push({ id: 'e2', sourceId: 'inA', targetId: 'inB' });
    const result = autoLayout(model, 'TD');
    const g1 = groupBox(result, 'g1');
    expect(encloses(g1, nodeBox(result, 'inA'))).toBe(true);
    expect(encloses(g1, nodeBox(result, 'inB'))).toBe(true);
    // Inside the group too, a connector puts its target below its source (TD).
    expect(nodeBox(result, 'inB').y).toBeGreaterThan(nodeBox(result, 'inA').y);
    // The outside node and the group don't overlap, and x (with a connector into g1) sits above it.
    expect(overlaps(nodeBox(result, 'x'), g1)).toBe(false);
    expect(nodeBox(result, 'x').y + nodeBox(result, 'x').height).toBeLessThanOrEqual(g1.y);
    expect(result.nodes.map((n) => n.containerId)).toEqual(model.nodes.map((n) => n.containerId));
  });

  it('nested groups each enclose theirs, siblings never overlap, and a group\'s own direction is used inside it', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, containerId: 'inner' },
        { id: 'b', label: 'B', shape: 'rectangle', position: { x: 0, y: 0 }, containerId: 'inner' },
        { id: 'c', label: 'C', shape: 'rectangle', position: { x: 0, y: 0 }, containerId: 'outer' },
        { id: 'd', label: 'D', shape: 'rectangle', position: { x: 0, y: 0 }, containerId: 'side' },
      ],
      edges: [
        { id: 'e1', sourceId: 'a', targetId: 'b' },
        { id: 'e2', sourceId: 'c', targetId: 'a' },
        { id: 'e3', sourceId: 'b', targetId: 'd' },
      ],
      containers: [
        { id: 'outer', label: 'Outer', position: { x: 0, y: 0 } },
        { id: 'inner', label: 'Inner', position: { x: 0, y: 0 }, parentContainerId: 'outer', direction: 'LR' },
        { id: 'side', label: 'Side', position: { x: 0, y: 0 } },
      ],
    };
    const result = autoLayout(model, 'TD');
    const outer = groupBox(result, 'outer');
    const inner = groupBox(result, 'inner');
    expect(encloses(outer, inner)).toBe(true);
    expect(encloses(inner, nodeBox(result, 'a'))).toBe(true);
    expect(encloses(outer, nodeBox(result, 'c'))).toBe(true);
    expect(encloses(groupBox(result, 'side'), nodeBox(result, 'd'))).toBe(true);
    expect(overlaps(outer, groupBox(result, 'side'))).toBe(false);
    expect(overlaps(inner, nodeBox(result, 'c'))).toBe(false);
    // inner is LR: b is right of a, on the same row.
    expect(nodeBox(result, 'b').x).toBeGreaterThan(nodeBox(result, 'a').x + nodeBox(result, 'a').width);
    expect(nodeBox(result, 'b').y).toBeCloseTo(nodeBox(result, 'a').y, 0);
  });
});

describe('autoLayout: every family', () => {
  const two = (diagramTypeId: string, extra: Partial<DiagramModel['nodes'][number]> = {}): DiagramModel => ({
    diagramTypeId,
    nodes: [
      { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, ...extra },
      { id: 'b', label: 'B', shape: 'rectangle', position: { x: 0, y: 0 }, ...extra },
    ],
    edges: [{ id: 'e1', sourceId: 'a', targetId: 'b' }],
    containers: [],
  });

  it('C4, ERD and UML are ranked like flowcharts; only families with a DSL direction record it', () => {
    for (const [family, typeId] of [['c4', 'c4-context'], ['erd', 'erd'], ['uml', 'uml-class']] as const) {
      const result = autoLayout(two(typeId), 'LR', family);
      expect(nodeBox(result, 'b').x, family).toBeGreaterThan(nodeBox(result, 'a').x);
      expect(result.direction, family).toBe(family === 'c4' ? undefined : 'LR');
    }
  });

  it('architecture follows its own hints: a connector anchored db:L -- R:server puts db right of server', () => {
    const model = two('architecture');
    model.edges = [{ id: 'e1', sourceId: 'a', targetId: 'b', sourceAnchor: 'L', targetAnchor: 'R' }];
    const result = autoLayout(model, 'TD', 'architecture');
    expect(nodeBox(result, 'a').x).toBeGreaterThan(nodeBox(result, 'b').x);
  });

  it('sequence diagrams are left exactly as they are', () => {
    const model = two('sequence');
    expect(autoLayout(model, 'LR', 'sequence')).toBe(model);
  });
});

describe('autoLayout: edges wholly inside one container', () => {
  it('is skipped and does not distort or error the top-level ranking of unrelated nodes', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'p', label: 'P', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'q', label: 'Q', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'inA', label: 'InA', shape: 'rectangle', position: { x: 10, y: 10 }, containerId: 'g1' },
        { id: 'inB', label: 'InB', shape: 'rectangle', position: { x: 10, y: 80 }, containerId: 'g1' },
      ],
      edges: [
        { id: 'e1', sourceId: 'p', targetId: 'q' },
        // Wholly internal to g1 (both endpoints resolve to the same top-level id) — must not
        // throw and must not affect p/q's own ranking relative to each other.
        { id: 'e2', sourceId: 'inA', targetId: 'inB' },
      ],
      containers: [{ id: 'g1', label: 'Group', position: { x: 200, y: 200 }, size: { width: 300, height: 200 } }],
    };

    expect(() => autoLayout(model, 'TD')).not.toThrow();
    const result = autoLayout(model, 'TD');
    const p = result.nodes.find((n) => n.id === 'p')!.position;
    const q = result.nodes.find((n) => n.id === 'q')!.position;
    expect(q.y).toBeGreaterThan(p.y);
    expect(q.x).toBeCloseTo(p.x, 0);
  });
});

describe('autoLayout: empty and trivial models', () => {
  it('an empty model returns unchanged apart from direction, without throwing', () => {
    const model = createEmptyDiagramModel('flowchart');
    const result = autoLayout(model, 'LR');
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.containers).toEqual([]);
    expect(result.direction).toBe('LR');
  });

  it('a single-node model with no edges does not throw and positions the node finitely', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'solo', label: 'Solo', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    };
    const result = autoLayout(model, 'TD');
    const pos = result.nodes.find((n) => n.id === 'solo')!.position;
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
  });
});

describe('autoLayout: content is untouched', () => {
  it('leaves node/edge label and shape content unchanged', () => {
    const model = chainModel();
    const result = autoLayout(model, 'TD');
    expect(result.nodes.map((n) => ({ id: n.id, label: n.label, shape: n.shape }))).toEqual(
      model.nodes.map((n) => ({ id: n.id, label: n.label, shape: n.shape })),
    );
    expect(result.edges).toEqual(model.edges);
  });

  it('does not mutate the input model', () => {
    const model = chainModel();
    const snapshot = JSON.parse(JSON.stringify(model));
    autoLayout(model, 'TD');
    expect(model).toEqual(snapshot);
  });
});
