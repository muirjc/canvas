import { describe, expect, it } from 'vitest';
import { removeNode, removeEdge, updateNodeLabel, updateEdgeLabel } from '../../src/model/diagram-ops.js';
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
