import { describe, expect, it } from 'vitest';
import {
  addNode,
  addEdge,
  removeNode,
  removeEdge,
  updateNodeLabel,
  updateEdgeLabel,
  updateNodeStyle,
  updateEdgeStyle,
  addContainer,
  updateContainerLabel,
  moveContainer,
  resizeContainer,
  assignNodeToContainer,
  removeNodeFromContainer,
  removeContainer,
} from '../../src/model/diagram-ops.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * Feature 002, Foundational: pure DiagramModel operations shared by shape deletion (US2) and
 * label editing (US1). Constitution I — these are the only path the canvas uses to mutate the
 * model, so they must be correct in isolation before any UI wiring happens.
 */
function baseModel(): DiagramModel {
  return {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, containerId: 'g1' },
      { id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } },
      { id: 'c', label: 'C', shape: 'circle', position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: 'e1', sourceId: 'a', targetId: 'b', label: 'connects' },
      { id: 'e2', sourceId: 'b', targetId: 'c' },
    ],
    containers: [{ id: 'g1', label: 'Group', position: { x: -20, y: -20 }, size: { width: 100, height: 100 } }],
  };
}

describe('addNode', () => {
  it('appends a new node with the given shape and label', () => {
    const model = baseModel();
    const result = addNode(model, { shape: 'diamond', label: 'Decision' });
    const added = result.nodes.find((n) => !model.nodes.some((existing) => existing.id === n.id))!;
    expect(added.shape).toBe('diamond');
    expect(added.label).toBe('Decision');
  });

  it('defaults the label to "New Node" when omitted', () => {
    const result = addNode(baseModel(), { shape: 'rectangle' });
    const added = result.nodes[result.nodes.length - 1];
    expect(added.label).toBe('New Node');
  });

  it('auto-positions the new node without colliding with the fixed-position existing nodes', () => {
    const model = baseModel();
    const result = addNode(model, { shape: 'rectangle' });
    const added = result.nodes[result.nodes.length - 1];
    expect(added.position).toBeDefined();
    expect(model.nodes.some((n) => n.position.x === added.position.x && n.position.y === added.position.y)).toBe(false);
  });

  it('leaves every existing node, edge, and container untouched', () => {
    const model = baseModel();
    const result = addNode(model, { shape: 'rectangle' });
    expect(result.nodes.slice(0, model.nodes.length)).toEqual(model.nodes);
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });

  it('does not mutate the input model', () => {
    const model = baseModel();
    const snapshot = JSON.parse(JSON.stringify(model));
    addNode(model, { shape: 'rectangle' });
    expect(model).toEqual(snapshot);
  });
});

describe('addEdge', () => {
  it('appends a new edge with the given source, target, and label', () => {
    const result = addEdge(baseModel(), { sourceId: 'a', targetId: 'c', label: 'shortcut' });
    const added = result.edges[result.edges.length - 1];
    expect(added.sourceId).toBe('a');
    expect(added.targetId).toBe('c');
    expect(added.label).toBe('shortcut');
  });

  it('omits the label when none is given', () => {
    const result = addEdge(baseModel(), { sourceId: 'a', targetId: 'c' });
    expect(result.edges[result.edges.length - 1].label).toBeUndefined();
  });

  it('does not validate that sourceId/targetId reference existing nodes', () => {
    const result = addEdge(baseModel(), { sourceId: 'a', targetId: 'does-not-exist' });
    expect(result.edges[result.edges.length - 1].targetId).toBe('does-not-exist');
  });

  it('leaves every existing node, edge, and container untouched', () => {
    const model = baseModel();
    const result = addEdge(model, { sourceId: 'a', targetId: 'c' });
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges.slice(0, model.edges.length)).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });

  it('does not mutate the input model', () => {
    const model = baseModel();
    const snapshot = JSON.parse(JSON.stringify(model));
    addEdge(model, { sourceId: 'a', targetId: 'c' });
    expect(model).toEqual(snapshot);
  });
});

describe('removeNode', () => {
  it('removes the node itself', () => {
    const result = removeNode(baseModel(), 'b');
    expect(result.nodes.map((n) => n.id)).toEqual(['a', 'c']);
  });

  it('removes every edge attached to the deleted node (no dangling reference)', () => {
    const result = removeNode(baseModel(), 'b');
    expect(result.edges).toEqual([]);
  });

  it('leaves edges not touching the deleted node intact', () => {
    const model = baseModel();
    model.edges.push({ id: 'e3', sourceId: 'a', targetId: 'c' });
    const result = removeNode(model, 'b');
    expect(result.edges.map((e) => e.id)).toEqual(['e3']);
  });

  it('auto-removes a group left with no remaining member nodes', () => {
    const result = removeNode(baseModel(), 'a');
    expect(result.containers).toEqual([]);
  });

  it('keeps a group that still has other member nodes', () => {
    const model = baseModel();
    model.nodes.push({ id: 'd', label: 'D', shape: 'rectangle', position: { x: 0, y: 200 }, containerId: 'g1' });
    const result = removeNode(model, 'a');
    expect(result.containers.map((c) => c.id)).toEqual(['g1']);
  });

  it('is idempotent — removing a nonexistent node id is a no-op', () => {
    const model = baseModel();
    const result = removeNode(model, 'does-not-exist');
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });

  it('does not mutate the input model', () => {
    const model = baseModel();
    const snapshot = JSON.parse(JSON.stringify(model));
    removeNode(model, 'b');
    expect(model).toEqual(snapshot);
  });
});

describe('removeEdge', () => {
  it('removes only the named edge, leaving nodes and containers untouched', () => {
    const model = baseModel();
    const result = removeEdge(model, 'e1');
    expect(result.edges.map((e) => e.id)).toEqual(['e2']);
    expect(result.nodes).toEqual(model.nodes);
    expect(result.containers).toEqual(model.containers);
  });

  it('is idempotent — removing a nonexistent edge id is a no-op', () => {
    const model = baseModel();
    const result = removeEdge(model, 'does-not-exist');
    expect(result).toEqual(model);
  });
});

describe('updateNodeLabel', () => {
  it('changes only the label field of the named node', () => {
    const model = baseModel();
    const result = updateNodeLabel(model, 'a', 'Renamed');
    const node = result.nodes.find((n) => n.id === 'a')!;
    expect(node.label).toBe('Renamed');
    expect(node.position).toEqual(model.nodes[0].position);
    expect(node.shape).toBe(model.nodes[0].shape);
  });

  it('leaves other nodes untouched', () => {
    const model = baseModel();
    const result = updateNodeLabel(model, 'a', 'Renamed');
    expect(result.nodes.find((n) => n.id === 'b')).toEqual(model.nodes.find((n) => n.id === 'b'));
  });

  it('rejects an empty label (shapes always keep a non-empty label)', () => {
    expect(() => updateNodeLabel(baseModel(), 'a', '')).toThrow();
  });
});

describe('updateEdgeLabel', () => {
  it('changes only the label field of the named edge', () => {
    const model = baseModel();
    const result = updateEdgeLabel(model, 'e2', 'now labeled');
    expect(result.edges.find((e) => e.id === 'e2')!.label).toBe('now labeled');
  });

  it('accepts an empty string to clear an existing label', () => {
    const model = baseModel();
    const result = updateEdgeLabel(model, 'e1', '');
    expect(result.edges.find((e) => e.id === 'e1')!.label).toBe('');
  });

  it('leaves nodes and containers untouched', () => {
    const model = baseModel();
    const result = updateEdgeLabel(model, 'e1', 'x');
    expect(result.nodes).toEqual(model.nodes);
    expect(result.containers).toEqual(model.containers);
  });
});

describe('updateNodeStyle', () => {
  it('sets fillColor/strokeColor on the named node', () => {
    const model = baseModel();
    const result = updateNodeStyle(model, 'a', { fillColor: '#1168bd', strokeColor: '#0b4884' });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({ fillColor: '#1168bd', strokeColor: '#0b4884' });
  });

  it('sets strokeWidth/strokeDasharray on the named node', () => {
    const result = updateNodeStyle(baseModel(), 'a', { strokeWidth: 3, strokeDasharray: '5 5' });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({ strokeWidth: 3, strokeDasharray: '5 5' });
  });

  it('merges into an existing style rather than replacing it', () => {
    const model = baseModel();
    model.nodes[0].style = { fillColor: '#ffffff', strokeWidth: 1 };
    const result = updateNodeStyle(model, 'a', { strokeColor: '#000000' });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({
      fillColor: '#ffffff',
      strokeWidth: 1,
      strokeColor: '#000000',
    });
  });

  it('overwrites only the fields present in the patch', () => {
    const model = baseModel();
    model.nodes[0].style = { fillColor: '#ffffff' };
    const result = updateNodeStyle(model, 'a', { fillColor: '#000000' });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({ fillColor: '#000000' });
  });

  it('leaves other nodes, edges, and containers untouched', () => {
    const model = baseModel();
    const result = updateNodeStyle(model, 'a', { fillColor: '#1168bd' });
    expect(result.nodes.find((n) => n.id === 'b')).toEqual(model.nodes.find((n) => n.id === 'b'));
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });

  it('is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(updateNodeStyle(model, 'nope', { fillColor: '#000000' })).toEqual(model);
  });
});

describe('updateEdgeStyle', () => {
  it('sets fillColor/strokeColor on the named edge', () => {
    const result = updateEdgeStyle(baseModel(), 'e1', { strokeColor: '#c0392b' });
    expect(result.edges.find((e) => e.id === 'e1')!.style).toEqual({ strokeColor: '#c0392b' });
  });

  it('merges into an existing style rather than replacing it', () => {
    const model = baseModel();
    model.edges[0].style = { strokeColor: '#c0392b' };
    const result = updateEdgeStyle(model, 'e1', { strokeWidth: 2 });
    expect(result.edges.find((e) => e.id === 'e1')!.style).toEqual({ strokeColor: '#c0392b', strokeWidth: 2 });
  });

  it('leaves nodes, other edges, and containers untouched', () => {
    const model = baseModel();
    const result = updateEdgeStyle(model, 'e1', { strokeColor: '#c0392b' });
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges.find((e) => e.id === 'e2')).toEqual(model.edges.find((e) => e.id === 'e2'));
    expect(result.containers).toEqual(model.containers);
  });

  it('is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(updateEdgeStyle(model, 'nope', { strokeColor: '#000000' })).toEqual(model);
  });
});

/**
 * Feature 006, User Story 2: container operations.
 *
 * Containers were previously assembled inline in the canvas component. These are the pure
 * operations the canvas, the DSL, and any future AI tool-calling all share — see
 * specs/006-authoring-admin-console/contracts/diagram-core-container-ops.md.
 */
function nestedModel(): DiagramModel {
  return {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'inA', label: 'In A', shape: 'rectangle', position: { x: 50, y: 50 }, containerId: 'outer' },
      { id: 'inB', label: 'In B', shape: 'rectangle', position: { x: 120, y: 60 }, containerId: 'inner' },
      { id: 'free', label: 'Free', shape: 'rectangle', position: { x: 500, y: 500 } },
    ],
    edges: [{ id: 'e1', sourceId: 'inA', targetId: 'free' }],
    containers: [
      { id: 'outer', label: 'Outer', position: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
      { id: 'inner', label: 'Inner', position: { x: 100, y: 40 }, size: { width: 150, height: 120 }, parentContainerId: 'outer' },
    ],
  };
}

describe('addContainer', () => {
  it('appends a container with a generated id', () => {
    const model = baseModel();
    const result = addContainer(model, {});
    expect(result.containers).toHaveLength(model.containers.length + 1);
    const added = result.containers[result.containers.length - 1];
    expect(added.id).toBeTruthy();
    expect(result.containers.filter((c) => c.id === added.id)).toHaveLength(1);
  });

  it('ALWAYS produces a size, even when none is supplied', () => {
    // The flowchart serializer omits containers without a size, which would silently lose the
    // container's position on the next parse (data-model.md invariant 1).
    const added = addContainer(baseModel(), {}).containers.at(-1)!;
    expect(added.size).toBeDefined();
    expect(added.size!.width).toBeGreaterThan(0);
    expect(added.size!.height).toBeGreaterThan(0);
  });

  it('uses the supplied label, position, and size when given', () => {
    const added = addContainer(baseModel(), {
      label: 'Payments Domain',
      position: { x: 12, y: 34 },
      size: { width: 222, height: 111 },
    }).containers.at(-1)!;
    expect(added.label).toBe('Payments Domain');
    expect(added.position).toEqual({ x: 12, y: 34 });
    expect(added.size).toEqual({ width: 222, height: 111 });
  });

  it('creates no membership and leaves nodes and edges untouched', () => {
    const model = baseModel();
    const result = addContainer(model, {});
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges).toEqual(model.edges);
  });
});

describe('updateContainerLabel', () => {
  it('renames only the named container', () => {
    const result = updateContainerLabel(baseModel(), 'g1', 'Renamed');
    expect(result.containers.find((c) => c.id === 'g1')!.label).toBe('Renamed');
  });

  it('rejects an empty label, mirroring updateNodeLabel', () => {
    expect(() => updateContainerLabel(baseModel(), 'g1', '')).toThrow();
  });

  it('leaves geometry and membership untouched', () => {
    const model = baseModel();
    const result = updateContainerLabel(model, 'g1', 'Renamed');
    const before = model.containers.find((c) => c.id === 'g1')!;
    const after = result.containers.find((c) => c.id === 'g1')!;
    expect(after.position).toEqual(before.position);
    expect(after.size).toEqual(before.size);
    expect(result.nodes).toEqual(model.nodes);
  });

  it('is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(updateContainerLabel(model, 'nope', 'x').containers).toEqual(model.containers);
  });
});

describe('moveContainer', () => {
  it('moves the container to the given position', () => {
    const result = moveContainer(baseModel(), 'g1', { x: 100, y: 100 });
    expect(result.containers.find((c) => c.id === 'g1')!.position).toEqual({ x: 100, y: 100 });
  });

  it('moves every member by the same delta, preserving relative positions', () => {
    const model = baseModel();
    const before = model.nodes.find((n) => n.id === 'a')!.position;
    // g1 sits at (-20,-20); moving to (80,30) is a delta of (+100,+50).
    const result = moveContainer(model, 'g1', { x: 80, y: 30 });
    const after = result.nodes.find((n) => n.id === 'a')!.position;
    expect(after).toEqual({ x: before.x + 100, y: before.y + 50 });
  });

  it('does not move non-members', () => {
    const model = baseModel();
    const result = moveContainer(model, 'g1', { x: 500, y: 500 });
    expect(result.nodes.find((n) => n.id === 'b')!.position).toEqual(
      model.nodes.find((n) => n.id === 'b')!.position,
    );
  });

  it('cascades to child containers and their members', () => {
    const model = nestedModel();
    const result = moveContainer(model, 'outer', { x: 10, y: 20 }); // delta (+10,+20)
    expect(result.containers.find((c) => c.id === 'inner')!.position).toEqual({ x: 110, y: 60 });
    expect(result.nodes.find((n) => n.id === 'inB')!.position).toEqual({ x: 130, y: 80 });
  });

  it('does not resize the container or change membership', () => {
    const model = baseModel();
    const result = moveContainer(model, 'g1', { x: 9, y: 9 });
    expect(result.containers.find((c) => c.id === 'g1')!.size).toEqual(
      model.containers.find((c) => c.id === 'g1')!.size,
    );
    expect(result.nodes.map((n) => n.containerId)).toEqual(model.nodes.map((n) => n.containerId));
  });

  it('is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(moveContainer(model, 'nope', { x: 1, y: 1 })).toEqual(model);
  });
});

describe('resizeContainer', () => {
  it('sets the size', () => {
    const result = resizeContainer(baseModel(), 'g1', { width: 640, height: 480 });
    expect(result.containers.find((c) => c.id === 'g1')!.size).toEqual({ width: 640, height: 480 });
  });

  it('moves and resizes nothing inside it', () => {
    const model = baseModel();
    const result = resizeContainer(model, 'g1', { width: 640, height: 480 });
    expect(result.nodes).toEqual(model.nodes);
  });

  it('does not change membership even when shrunk below its contents', () => {
    const model = baseModel();
    const result = resizeContainer(model, 'g1', { width: 1, height: 1 });
    expect(result.nodes.find((n) => n.id === 'a')!.containerId).toBe('g1');
  });

  it('does not move the container', () => {
    const model = baseModel();
    const result = resizeContainer(model, 'g1', { width: 10, height: 10 });
    expect(result.containers.find((c) => c.id === 'g1')!.position).toEqual(
      model.containers.find((c) => c.id === 'g1')!.position,
    );
  });

  it('is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(resizeContainer(model, 'nope', { width: 5, height: 5 })).toEqual(model);
  });
});

describe('assignNodeToContainer / removeNodeFromContainer', () => {
  it('assigns membership without moving the node', () => {
    const model = baseModel();
    const result = assignNodeToContainer(model, 'b', 'g1');
    expect(result.nodes.find((n) => n.id === 'b')!.containerId).toBe('g1');
    expect(result.nodes.find((n) => n.id === 'b')!.position).toEqual(
      model.nodes.find((n) => n.id === 'b')!.position,
    );
  });

  it('replaces prior membership rather than adding a second', () => {
    const model = addContainer(baseModel(), { label: 'Other' });
    const otherId = model.containers.at(-1)!.id;
    const result = assignNodeToContainer(model, 'a', otherId);
    expect(result.nodes.find((n) => n.id === 'a')!.containerId).toBe(otherId);
  });

  it('clears membership without moving the node', () => {
    const model = baseModel();
    const result = removeNodeFromContainer(model, 'a');
    expect(result.nodes.find((n) => n.id === 'a')!.containerId).toBeUndefined();
    expect(result.nodes.find((n) => n.id === 'a')!.position).toEqual(
      model.nodes.find((n) => n.id === 'a')!.position,
    );
  });

  it('leaves the container itself in place when a member is removed', () => {
    const model = baseModel();
    const result = removeNodeFromContainer(model, 'a');
    expect(result.containers).toEqual(model.containers);
  });

  it('is a no-op for unknown ids', () => {
    const model = baseModel();
    expect(assignNodeToContainer(model, 'nope', 'g1')).toEqual(model);
    expect(assignNodeToContainer(model, 'b', 'nope')).toEqual(model);
    expect(removeNodeFromContainer(model, 'nope')).toEqual(model);
  });
});

describe('removeContainer', () => {
  it('removes the container', () => {
    const result = removeContainer(baseModel(), 'g1');
    expect(result.containers.find((c) => c.id === 'g1')).toBeUndefined();
  });

  it('NEVER removes the nodes it held, and leaves their positions untouched', () => {
    const model = baseModel();
    const result = removeContainer(model, 'g1');
    expect(result.nodes).toHaveLength(model.nodes.length);
    expect(result.nodes.find((n) => n.id === 'a')!.position).toEqual(
      model.nodes.find((n) => n.id === 'a')!.position,
    );
  });

  it('releases members by clearing their containerId', () => {
    const result = removeContainer(baseModel(), 'g1');
    expect(result.nodes.find((n) => n.id === 'a')!.containerId).toBeUndefined();
  });

  it('re-parents child containers rather than deleting them', () => {
    const model = nestedModel();
    const result = removeContainer(model, 'outer');
    const inner = result.containers.find((c) => c.id === 'inner');
    expect(inner).toBeDefined();
    expect(inner!.parentContainerId).toBeUndefined();
    expect(result.nodes.find((n) => n.id === 'inB')!.containerId).toBe('inner');
  });

  it('leaves edges untouched', () => {
    const model = baseModel();
    expect(removeContainer(model, 'g1').edges).toEqual(model.edges);
  });

  it('is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(removeContainer(model, 'nope')).toEqual(model);
  });
});
