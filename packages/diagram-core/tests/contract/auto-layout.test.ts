import { describe, expect, it } from 'vitest';
import { autoLayout } from '../../src/model/auto-layout.js';
import { createEmptyDiagramModel, type DiagramModel } from '../../src/model/diagram-model.js';

/**
 * canvas-esn: dagre-based Auto Layout for flowchart-family diagrams. v1 is FLAT — only
 * container-less nodes and top-level containers are laid out directly by dagre; a container's
 * own contents are shifted afterward via the existing `moveContainer` (already covered by
 * `diagram-ops.test.ts`), preserving each member's relative position exactly.
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

describe('autoLayout: containers', () => {
  it('preserves a member node\'s position relative to its container after the container moves', () => {
    const model = containerModel();
    const before = model.containers.find((c) => c.id === 'g1')!.position;
    const inABefore = model.nodes.find((n) => n.id === 'inA')!.position;
    const inBBefore = model.nodes.find((n) => n.id === 'inB')!.position;
    const relA = { x: inABefore.x - before.x, y: inABefore.y - before.y };
    const relB = { x: inBBefore.x - before.x, y: inBBefore.y - before.y };

    const result = autoLayout(model, 'TD');

    const after = result.containers.find((c) => c.id === 'g1')!.position;
    // Sanity check the premise: the container actually moved (there's an edge from a top-level
    // node into one of its members, forcing dagre to rank it away from the origin).
    expect(after).not.toEqual(before);

    const inAAfter = result.nodes.find((n) => n.id === 'inA')!.position;
    const inBAfter = result.nodes.find((n) => n.id === 'inB')!.position;
    expect({ x: inAAfter.x - after.x, y: inAAfter.y - after.y }).toEqual(relA);
    expect({ x: inBAfter.x - after.x, y: inBAfter.y - after.y }).toEqual(relB);
  });

  it('does not resize the container or change any membership', () => {
    const model = containerModel();
    const result = autoLayout(model, 'TD');
    expect(result.containers.find((c) => c.id === 'g1')!.size).toEqual(
      model.containers.find((c) => c.id === 'g1')!.size,
    );
    expect(result.nodes.map((n) => n.containerId)).toEqual(model.nodes.map((n) => n.containerId));
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
