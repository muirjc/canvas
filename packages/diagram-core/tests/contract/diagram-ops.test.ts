import { describe, expect, it } from 'vitest';
import {
  addNode,
  addEdge,
  removeNode,
  removeEdge,
  updateNodeLabel,
  setNodeLink,
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
  setContainerRole,
  setContainerDirection,
  setContainerParent,
  removeContainerParent,
  assignEdgeToContainer,
  removeEdgeFromContainer,
  updateNodeRole,
  updateEntityAttributes,
  updateClassMembers,
  updateEdgeRelationKind,
  updateEdgeErCardinality,
  updateEdgeArrowStyle,
  updateNodeStereotype,
  addPointMarkerContainer,
  setSequenceAutonumber,
} from '../../src/model/diagram-ops.js';
import type { DiagramModel, EntityAttribute, ClassMember } from '../../src/model/diagram-model.js';

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

  it('sets arrow when given (canvas-7rr: bidirectional/no-arrowhead at connect time)', () => {
    const result = addEdge(baseModel(), { sourceId: 'a', targetId: 'c', arrow: 'both' });
    expect(result.edges[result.edges.length - 1].arrow).toBe('both');
  });

  it('omits arrow (defaults to a plain forward arrow) when none is given', () => {
    const result = addEdge(baseModel(), { sourceId: 'a', targetId: 'c' });
    expect(result.edges[result.edges.length - 1].arrow).toBeUndefined();
  });

  it('sets erSourceCardinality/erTargetCardinality when given (canvas-vcv follow-up: the ER connect-mode gesture)', () => {
    const result = addEdge(baseModel(), { sourceId: 'a', targetId: 'c', erSourceCardinality: '||', erTargetCardinality: 'o{' });
    const added = result.edges[result.edges.length - 1];
    expect(added.erSourceCardinality).toBe('||');
    expect(added.erTargetCardinality).toBe('o{');
  });

  it('omits ER cardinality when none is given (every non-ERD caller)', () => {
    const result = addEdge(baseModel(), { sourceId: 'a', targetId: 'c' });
    const added = result.edges[result.edges.length - 1];
    expect(added.erSourceCardinality).toBeUndefined();
    expect(added.erTargetCardinality).toBeUndefined();
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

describe('setNodeLink (jmuir-dzd.5)', () => {
  it('sets the link field of the named node', () => {
    const result = setNodeLink(baseModel(), 'a', { href: 'https://example.com' });
    expect(result.nodes.find((n) => n.id === 'a')!.link).toEqual({ href: 'https://example.com' });
  });

  it('sets tooltip and target when given', () => {
    const result = setNodeLink(baseModel(), 'a', { href: 'https://example.com', tooltip: 'Visit', target: '_blank' });
    expect(result.nodes.find((n) => n.id === 'a')!.link).toEqual({
      href: 'https://example.com',
      tooltip: 'Visit',
      target: '_blank',
    });
  });

  it('replaces a previously-set link wholesale, not merged', () => {
    let model = setNodeLink(baseModel(), 'a', { href: 'https://old.example.com', tooltip: 'Old' });
    model = setNodeLink(model, 'a', { href: 'https://new.example.com' });
    expect(model.nodes.find((n) => n.id === 'a')!.link).toEqual({ href: 'https://new.example.com' });
  });

  it('clears a previously-set link back to unset when given null', () => {
    let model = setNodeLink(baseModel(), 'a', { href: 'https://example.com' });
    model = setNodeLink(model, 'a', null);
    expect(model.nodes.find((n) => n.id === 'a')!.link).toBeUndefined();
  });

  it('is a no-op for an unknown node id', () => {
    const model = baseModel();
    expect(setNodeLink(model, 'nope', { href: 'https://example.com' })).toEqual(model);
  });

  it('leaves other nodes, edges, and containers untouched', () => {
    const model = baseModel();
    const result = setNodeLink(model, 'a', { href: 'https://example.com' });
    expect(result.nodes.find((n) => n.id === 'b')).toEqual(model.nodes.find((n) => n.id === 'b'));
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });

  // The mandatory security boundary: this op is a non-DSL-import path that also sets `link`
  // (the canvas UI popup, and any future AI tool) — it must never silently accept a disallowed
  // scheme, the same "clean rejection, not silent tolerance" posture the parser enforces.
  it('rejects a "javascript:" scheme href (throws, mirrors updateNodeLabel\'s own empty-label precedent)', () => {
    expect(() => setNodeLink(baseModel(), 'a', { href: 'javascript:alert(1)' })).toThrow();
  });

  it('rejects a "data:" scheme href', () => {
    expect(() => setNodeLink(baseModel(), 'a', { href: 'data:text/html,x' })).toThrow();
  });

  it('accepts http(s) and a relative path', () => {
    expect(() => setNodeLink(baseModel(), 'a', { href: 'http://example.com' })).not.toThrow();
    expect(() => setNodeLink(baseModel(), 'a', { href: 'https://example.com' })).not.toThrow();
    expect(() => setNodeLink(baseModel(), 'a', { href: '/docs/x' })).not.toThrow();
  });

  it('clearing (link: null) never throws, even though it skips the href check entirely', () => {
    expect(() => setNodeLink(baseModel(), 'a', null)).not.toThrow();
  });

  // appsec review (jmuir-dzd.5): serializeClickHref (flowchart-serializer.ts) re-emits href/
  // tooltip inside a literal `"..."` DSL token with no escape syntax -- an embedded quote would
  // prematurely close it, and a raw newline would inject an entirely separate DSL statement
  // (e.g. a second click line targeting a DIFFERENT node whose own href was never validated).
  // Rejected here (not escaped), matching this op's own "throw on a genuine precondition
  // violation" convention.
  it('rejects an href containing a double-quote', () => {
    expect(() => setNodeLink(baseModel(), 'a', { href: 'https://example.com/"><script>' })).toThrow();
  });

  it('rejects an href containing a newline (DSL statement injection)', () => {
    expect(() =>
      setNodeLink(baseModel(), 'a', { href: 'https://example.com"\nclick b href "javascript:alert(1)' }),
    ).toThrow();
  });

  it('rejects a tooltip containing a double-quote or newline, even when href itself is clean', () => {
    expect(() => setNodeLink(baseModel(), 'a', { href: 'https://example.com', tooltip: 'a "quote"' })).toThrow();
    expect(() => setNodeLink(baseModel(), 'a', { href: 'https://example.com', tooltip: 'line1\nline2' })).toThrow();
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

  it('an explicit null clears a field back to unset, unlike omitting it', () => {
    const model = baseModel();
    model.nodes[0].style = { fillColor: '#ffffff', strokeColor: '#000000' };
    const result = updateNodeStyle(model, 'a', { fillColor: null });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({ strokeColor: '#000000' });
  });

  it('clearing every field leaves an empty style object, not undefined', () => {
    const model = baseModel();
    model.nodes[0].style = { fillColor: '#ffffff' };
    const result = updateNodeStyle(model, 'a', { fillColor: null });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({});
  });

  // canvas-2s6.7: fontFamily/fontSize were already real NodeStyle fields but StylePatch never
  // carried either one, so neither was actually settable through this shared op at all.
  it('sets fontFamily/fontSize on the named node', () => {
    const result = updateNodeStyle(baseModel(), 'a', { fontFamily: 'Arial', fontSize: 16 });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({ fontFamily: 'Arial', fontSize: 16 });
  });

  it('an explicit null clears fontFamily/fontSize back to unset', () => {
    const model = baseModel();
    model.nodes[0].style = { fontFamily: 'Arial', fontSize: 16 };
    const result = updateNodeStyle(model, 'a', { fontFamily: null, fontSize: null });
    expect(result.nodes.find((n) => n.id === 'a')!.style).toEqual({});
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

  it('an explicit null clears a field back to unset, unlike omitting it', () => {
    const model = baseModel();
    model.edges[0].style = { strokeColor: '#c0392b', strokeWidth: 2 };
    const result = updateEdgeStyle(model, 'e1', { strokeColor: null });
    expect(result.edges.find((e) => e.id === 'e1')!.style).toEqual({ strokeWidth: 2 });
  });

  // canvas-2s6.7: same StylePatch-widening fix as updateNodeStyle's own fontFamily/fontSize cases.
  it('sets fontFamily/fontSize on the named edge', () => {
    const result = updateEdgeStyle(baseModel(), 'e1', { fontFamily: 'Georgia', fontSize: 12 });
    expect(result.edges.find((e) => e.id === 'e1')!.style).toEqual({ fontFamily: 'Georgia', fontSize: 12 });
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

  // canvas-2s6.1: role/parentContainerId/attachedNodeIds/sequenceOrder — every prior test above
  // (all omitting these) still passes unchanged, confirming existing callers (groupSelected,
  // groupIntoContainer) are unaffected until they opt in.
  it('sets role, parentContainerId, attachedNodeIds, and sequenceOrder when supplied', () => {
    const model = addContainer(baseModel(), { label: 'Outer' });
    const outerId = model.containers.at(-1)!.id;
    const added = addContainer(model, {
      role: 'note-left',
      parentContainerId: outerId,
      attachedNodeIds: ['a', 'b'],
      sequenceOrder: 3,
    }).containers.at(-1)!;
    expect(added.role).toBe('note-left');
    expect(added.parentContainerId).toBe(outerId);
    expect(added.attachedNodeIds).toEqual(['a', 'b']);
    expect(added.sequenceOrder).toBe(3);
  });

  it('leaves role, parentContainerId, attachedNodeIds, and sequenceOrder unset when omitted', () => {
    const added = addContainer(baseModel(), {}).containers.at(-1)!;
    expect(added.role).toBeUndefined();
    expect(added.parentContainerId).toBeUndefined();
    expect(added.attachedNodeIds).toBeUndefined();
    expect(added.sequenceOrder).toBeUndefined();
  });

  // canvas-2s6.2: sequence `rect <color> ... end` needs its color set at creation time — there's
  // no dedicated container-style op to "create then patch" onto, unlike node/edge style.
  it('sets style when supplied (sequence rect highlight color)', () => {
    const added = addContainer(baseModel(), { role: 'rect', style: { fillColor: 'rgb(200, 200, 0)' } }).containers.at(-1)!;
    expect(added.style).toEqual({ fillColor: 'rgb(200, 200, 0)' });
  });

  it('leaves style unset when omitted', () => {
    const added = addContainer(baseModel(), {}).containers.at(-1)!;
    expect(added.style).toBeUndefined();
  });
});

describe('setContainerRole', () => {
  it('sets the role field of the named container', () => {
    const result = setContainerRole(baseModel(), 'g1', 'namespace');
    expect(result.containers.find((c) => c.id === 'g1')!.role).toBe('namespace');
  });

  it('is a no-op for an unknown container id', () => {
    const model = baseModel();
    expect(setContainerRole(model, 'nope', 'namespace')).toEqual(model);
  });

  it('leaves every other field on the same container, and every node/edge, untouched', () => {
    const model = baseModel();
    const result = setContainerRole(model, 'g1', 'namespace');
    const container = result.containers.find((c) => c.id === 'g1')!;
    expect(container.position).toEqual(model.containers[0].position);
    expect(container.size).toEqual(model.containers[0].size);
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges).toEqual(model.edges);
  });
});

describe('setContainerDirection', () => {
  it('sets the direction field of the named container', () => {
    const result = setContainerDirection(baseModel(), 'g1', 'LR');
    expect(result.containers.find((c) => c.id === 'g1')!.direction).toBe('LR');
  });

  it('clears a previously-set direction back to unset when given undefined', () => {
    let model = baseModel();
    model = setContainerDirection(model, 'g1', 'LR');
    const result = setContainerDirection(model, 'g1', undefined);
    expect(result.containers.find((c) => c.id === 'g1')!.direction).toBeUndefined();
  });

  it('is a no-op for an unknown container id', () => {
    const model = baseModel();
    expect(setContainerDirection(model, 'nope', 'TD')).toEqual(model);
  });

  it('leaves every other field on the same container, and every node/edge, untouched', () => {
    const model = baseModel();
    const result = setContainerDirection(model, 'g1', 'BT');
    const container = result.containers.find((c) => c.id === 'g1')!;
    expect(container.position).toEqual(model.containers[0].position);
    expect(container.size).toEqual(model.containers[0].size);
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges).toEqual(model.edges);
  });
});

describe('setContainerParent / removeContainerParent', () => {
  it('nests a container inside another', () => {
    const model = addContainer(nestedModel(), { label: 'Third' });
    const thirdId = model.containers.at(-1)!.id;
    const result = setContainerParent(model, thirdId, 'outer');
    expect(result.containers.find((c) => c.id === thirdId)!.parentContainerId).toBe('outer');
  });

  it('is a no-op when nesting a container inside itself', () => {
    const model = baseModel();
    expect(setContainerParent(model, 'g1', 'g1')).toEqual(model);
  });

  it('is a no-op for unknown ids', () => {
    const model = baseModel();
    expect(setContainerParent(model, 'nope', 'g1')).toEqual(model);
    expect(setContainerParent(model, 'g1', 'nope')).toEqual(model);
  });

  // canvas-2s6.8: a real gap found while wiring drag-to-nest -- direct self-nesting was already
  // guarded, but nesting a container into one of its OWN descendants was not.
  it('is a no-op when nesting a container into its own direct child (a 2-level cycle)', () => {
    const model = nestedModel();
    expect(setContainerParent(model, 'outer', 'inner')).toEqual(model);
  });

  it('is a no-op when nesting a container into a deeper descendant (a 3-level cycle)', () => {
    let model = addContainer(nestedModel(), { label: 'Grandchild' });
    const grandchildId = model.containers.at(-1)!.id;
    model = setContainerParent(model, grandchildId, 'inner');
    // outer -> inner -> grandchild; nesting outer into grandchild would close the loop.
    expect(setContainerParent(model, 'outer', grandchildId)).toEqual(model);
  });

  it('still allows nesting into an unrelated container (not a false-positive cycle rejection)', () => {
    const model = addContainer(nestedModel(), { label: 'Sibling' });
    const siblingId = model.containers.at(-1)!.id;
    const result = setContainerParent(model, siblingId, 'inner');
    expect(result.containers.find((c) => c.id === siblingId)!.parentContainerId).toBe('inner');
  });

  it('removeContainerParent un-nests a container back to top-level', () => {
    const model = nestedModel();
    const result = removeContainerParent(model, 'inner');
    expect(result.containers.find((c) => c.id === 'inner')!.parentContainerId).toBeUndefined();
  });

  it('removeContainerParent is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(removeContainerParent(model, 'nope')).toEqual(model);
  });
});

describe('assignEdgeToContainer / removeEdgeFromContainer', () => {
  it('assigns a message to a control-flow-block container without touching its endpoints', () => {
    const model = baseModel();
    const result = assignEdgeToContainer(model, 'e1', 'g1');
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.containerId).toBe('g1');
    expect(edge.sourceId).toBe('a');
    expect(edge.targetId).toBe('b');
  });

  it('replaces prior membership rather than adding a second', () => {
    const model = addContainer(baseModel(), { label: 'Other' });
    const otherId = model.containers.at(-1)!.id;
    const withFirst = assignEdgeToContainer(model, 'e1', 'g1');
    const result = assignEdgeToContainer(withFirst, 'e1', otherId);
    expect(result.edges.find((e) => e.id === 'e1')!.containerId).toBe(otherId);
  });

  it('clears membership without touching endpoints', () => {
    const model = assignEdgeToContainer(baseModel(), 'e1', 'g1');
    const result = removeEdgeFromContainer(model, 'e1');
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.containerId).toBeUndefined();
    expect(edge.sourceId).toBe('a');
    expect(edge.targetId).toBe('b');
  });

  it('is a no-op for unknown ids', () => {
    const model = baseModel();
    expect(assignEdgeToContainer(model, 'nope', 'g1')).toEqual(model);
    expect(assignEdgeToContainer(model, 'e1', 'nope')).toEqual(model);
    expect(removeEdgeFromContainer(model, 'nope')).toEqual(model);
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

  it('leaves edges untouched when none reference the container', () => {
    const model = baseModel();
    expect(removeContainer(model, 'g1').edges).toEqual(model.edges);
  });

  // canvas-2s6.1: DiagramEdge.containerId (a sequence message's own control-flow-block
  // membership) didn't exist as an assignable concept before this bead — same "no dangling
  // reference" invariant as the node-release case above, now that it does.
  it('releases member edges by clearing their containerId, same as member nodes', () => {
    const model = assignEdgeToContainer(baseModel(), 'e1', 'g1');
    const result = removeContainer(model, 'g1');
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.containerId).toBeUndefined();
    expect(edge.sourceId).toBe('a');
    expect(edge.targetId).toBe('b');
  });

  it('is a no-op for an unknown id', () => {
    const model = baseModel();
    expect(removeContainer(model, 'nope')).toEqual(model);
  });
});

/**
 * Feature 010, User Story 2 (T011-T016): new narrow AI-tool-facing operations for ER attributes,
 * UML members, UML/sequence-adjacent edge relation kind and arrow styling, node role, and
 * sequence activation/deactivation point markers. Per Constitution IV, these are contract tests
 * written before `diagram-ops.ts` implements the corresponding functions — they are EXPECTED to
 * fail right now (import/"not a function") until that follow-up work lands.
 */
describe('updateNodeRole', () => {
  it('sets the role field of the named node', () => {
    const model = baseModel();
    const result = updateNodeRole(model, 'a', 'system');
    expect(result.nodes.find((n) => n.id === 'a')!.role).toBe('system');
  });

  it('is a no-op for an unknown node id', () => {
    const model = baseModel();
    expect(updateNodeRole(model, 'nope', 'x')).toEqual(model);
  });

  it('leaves every other field on the same node, and every other node/edge/container, untouched', () => {
    const model = baseModel();
    const result = updateNodeRole(model, 'a', 'system');
    const node = result.nodes.find((n) => n.id === 'a')!;
    expect(node.position).toEqual(model.nodes[0].position);
    expect(node.shape).toBe(model.nodes[0].shape);
    expect(node.label).toBe(model.nodes[0].label);
    expect(result.nodes.find((n) => n.id === 'b')).toEqual(model.nodes.find((n) => n.id === 'b'));
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });
});

describe('updateEntityAttributes', () => {
  const attrsA: EntityAttribute[] = [{ type: 'string', name: 'id', keys: ['PK'] }];
  const attrsB: EntityAttribute[] = [
    { type: 'string', name: 'email', keys: [], comment: 'unique login' },
    { type: 'int', name: 'age', keys: [] },
  ];

  it('replaces attributes wholesale, not merged, when the node already has some', () => {
    const model = baseModel();
    model.nodes[0].attributes = attrsA;
    const result = updateEntityAttributes(model, 'a', attrsB);
    expect(result.nodes.find((n) => n.id === 'a')!.attributes).toEqual(attrsB);
  });

  it('sets attributes on a node with none yet', () => {
    const result = updateEntityAttributes(baseModel(), 'a', attrsA);
    expect(result.nodes.find((n) => n.id === 'a')!.attributes).toEqual(attrsA);
  });

  it('passing [] clears attributes to an empty array, not undefined and not the old array', () => {
    const model = baseModel();
    model.nodes[0].attributes = attrsA;
    const result = updateEntityAttributes(model, 'a', []);
    expect(result.nodes.find((n) => n.id === 'a')!.attributes).toEqual([]);
  });

  it('is a no-op for an unknown node id', () => {
    const model = baseModel();
    expect(updateEntityAttributes(model, 'nope', attrsA)).toEqual(model);
  });

  it('leaves other nodes, edges, and containers untouched', () => {
    const model = baseModel();
    const result = updateEntityAttributes(model, 'a', attrsA);
    expect(result.nodes.find((n) => n.id === 'b')).toEqual(model.nodes.find((n) => n.id === 'b'));
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });
});

describe('updateClassMembers', () => {
  const membersA: ClassMember[] = [
    { kind: 'attribute', visibility: '+', name: 'name', type: 'string' },
  ];
  const membersB: ClassMember[] = [
    { kind: 'method', visibility: '-', name: 'save', params: '', returnType: 'void', isStatic: true },
    { kind: 'attribute', name: 'count', type: 'int', isAbstract: false },
  ];

  it('replaces members wholesale, not merged, when the node already has some', () => {
    const model = baseModel();
    model.nodes[0].members = membersA;
    const result = updateClassMembers(model, 'a', membersB);
    expect(result.nodes.find((n) => n.id === 'a')!.members).toEqual(membersB);
  });

  it('sets members on a node with none yet', () => {
    const result = updateClassMembers(baseModel(), 'a', membersA);
    expect(result.nodes.find((n) => n.id === 'a')!.members).toEqual(membersA);
  });

  it('passing [] clears members to an empty array, not undefined and not the old array', () => {
    const model = baseModel();
    model.nodes[0].members = membersA;
    const result = updateClassMembers(model, 'a', []);
    expect(result.nodes.find((n) => n.id === 'a')!.members).toEqual([]);
  });

  it('is a no-op for an unknown node id', () => {
    const model = baseModel();
    expect(updateClassMembers(model, 'nope', membersA)).toEqual(model);
  });

  it('leaves other nodes, edges, and containers untouched', () => {
    const model = baseModel();
    const result = updateClassMembers(model, 'a', membersA);
    expect(result.nodes.find((n) => n.id === 'b')).toEqual(model.nodes.find((n) => n.id === 'b'));
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });
});

describe('updateNodeStereotype', () => {
  it('sets the umlStereotype field of the named node', () => {
    const result = updateNodeStereotype(baseModel(), 'a', 'interface');
    expect(result.nodes.find((n) => n.id === 'a')!.umlStereotype).toBe('interface');
  });

  it('an empty string clears it back to unset', () => {
    const model = baseModel();
    model.nodes[0].umlStereotype = 'abstract';
    const result = updateNodeStereotype(model, 'a', '');
    expect(result.nodes.find((n) => n.id === 'a')!.umlStereotype).toBeUndefined();
  });

  it('is a no-op for an unknown node id', () => {
    const model = baseModel();
    expect(updateNodeStereotype(model, 'nope', 'interface')).toEqual(model);
  });

  it('leaves every other field on the same node, and every other node/edge/container, untouched', () => {
    const model = baseModel();
    const result = updateNodeStereotype(model, 'a', 'interface');
    const node = result.nodes.find((n) => n.id === 'a')!;
    expect(node.position).toEqual(model.nodes[0].position);
    expect(node.shape).toBe(model.nodes[0].shape);
    expect(node.label).toBe(model.nodes[0].label);
    expect(result.nodes.find((n) => n.id === 'b')).toEqual(model.nodes.find((n) => n.id === 'b'));
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });
});

describe('updateEdgeRelationKind', () => {
  it('sets umlRelationKind while leaving sourceCardinality/targetCardinality alone when already set', () => {
    const model = baseModel();
    model.edges[0].sourceCardinality = '1';
    model.edges[0].targetCardinality = '*';
    const result = updateEdgeRelationKind(model, 'e1', { umlRelationKind: 'composition' });
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.umlRelationKind).toBe('composition');
    expect(edge.sourceCardinality).toBe('1');
    expect(edge.targetCardinality).toBe('*');
  });

  it('an explicit null clears a previously-set field back to unset, while a field set alongside it is untouched', () => {
    const model = baseModel();
    model.edges[0].umlRelationKind = 'association';
    model.edges[0].sourceCardinality = '1';
    model.edges[0].targetCardinality = '*';
    const result = updateEdgeRelationKind(model, 'e1', { sourceCardinality: null, targetCardinality: '0..1' });
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.sourceCardinality).toBeUndefined();
    expect(edge.targetCardinality).toBe('0..1');
    expect(edge.umlRelationKind).toBe('association');
  });

  it('is a no-op for an unknown edge id', () => {
    const model = baseModel();
    expect(updateEdgeRelationKind(model, 'nope', { umlRelationKind: 'dependency' })).toEqual(model);
  });

  it('leaves nodes, other edges, and containers untouched', () => {
    const model = baseModel();
    const result = updateEdgeRelationKind(model, 'e1', { umlRelationKind: 'inheritance' });
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges.find((e) => e.id === 'e2')).toEqual(model.edges.find((e) => e.id === 'e2'));
    expect(result.containers).toEqual(model.containers);
  });
});

describe('updateEdgeErCardinality', () => {
  it('sets erSourceCardinality/erTargetCardinality', () => {
    const result = updateEdgeErCardinality(baseModel(), 'e1', { erSourceCardinality: '||', erTargetCardinality: 'o{' });
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.erSourceCardinality).toBe('||');
    expect(edge.erTargetCardinality).toBe('o{');
  });

  it('patches one side while leaving the other alone when already set', () => {
    const model = baseModel();
    model.edges[0].erSourceCardinality = '||';
    model.edges[0].erTargetCardinality = 'o{';
    const result = updateEdgeErCardinality(model, 'e1', { erTargetCardinality: '|{' });
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.erSourceCardinality).toBe('||');
    expect(edge.erTargetCardinality).toBe('|{');
  });

  it('an explicit null clears a previously-set field back to unset', () => {
    const model = baseModel();
    model.edges[0].erSourceCardinality = '||';
    model.edges[0].erTargetCardinality = 'o{';
    const result = updateEdgeErCardinality(model, 'e1', { erSourceCardinality: null });
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.erSourceCardinality).toBeUndefined();
    expect(edge.erTargetCardinality).toBe('o{');
  });

  it('is a no-op for an unknown edge id', () => {
    const model = baseModel();
    expect(updateEdgeErCardinality(model, 'nope', { erSourceCardinality: '||' })).toEqual(model);
  });

  it('leaves nodes, other edges, and containers untouched', () => {
    const model = baseModel();
    const result = updateEdgeErCardinality(model, 'e1', { erSourceCardinality: '||' });
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges.find((e) => e.id === 'e2')).toEqual(model.edges.find((e) => e.id === 'e2'));
    expect(result.containers).toEqual(model.containers);
  });
});

describe('updateEdgeArrowStyle', () => {
  it('sets arrow while leaving lineStyle alone when omitted', () => {
    const model = baseModel();
    model.edges[0].lineStyle = 'dotted';
    const result = updateEdgeArrowStyle(model, 'e1', { arrow: 'both' });
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.arrow).toBe('both');
    expect(edge.lineStyle).toBe('dotted');
  });

  it('an explicit null clears a previously-set field back to unset, while a field set alongside it is untouched', () => {
    const model = baseModel();
    model.edges[0].arrow = 'both';
    model.edges[0].lineStyle = 'dotted';
    const result = updateEdgeArrowStyle(model, 'e1', { arrow: null, lineStyle: 'thick' });
    const edge = result.edges.find((e) => e.id === 'e1')!;
    expect(edge.arrow).toBeUndefined();
    expect(edge.lineStyle).toBe('thick');
  });

  it('is a no-op for an unknown edge id', () => {
    const model = baseModel();
    expect(updateEdgeArrowStyle(model, 'nope', { arrow: 'cross' })).toEqual(model);
  });

  it('leaves nodes, other edges, and containers untouched', () => {
    const model = baseModel();
    const result = updateEdgeArrowStyle(model, 'e1', { arrow: 'none' });
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges.find((e) => e.id === 'e2')).toEqual(model.edges.find((e) => e.id === 'e2'));
    expect(result.containers).toEqual(model.containers);
  });
});

describe('addPointMarkerContainer', () => {
  it('appends exactly one new activate container attached to the given node', () => {
    const model = baseModel();
    const result = addPointMarkerContainer(model, { role: 'activate', attachedNodeId: 'a' });
    expect(result.containers).toHaveLength(model.containers.length + 1);
    const added = result.containers.at(-1)!;
    expect(added.label).toBe('');
    expect(added.role).toBe('activate');
    expect(added.attachedNodeIds).toEqual(['a']);
    expect(added.position).toBeDefined();
  });

  it('appends exactly one new deactivate container attached to the given node', () => {
    const model = baseModel();
    const result = addPointMarkerContainer(model, { role: 'deactivate', attachedNodeId: 'b' });
    expect(result.containers).toHaveLength(model.containers.length + 1);
    const added = result.containers.at(-1)!;
    expect(added.label).toBe('');
    expect(added.role).toBe('deactivate');
    expect(added.attachedNodeIds).toEqual(['b']);
    expect(added.position).toBeDefined();
  });

  it('uses the given sequenceOrder exactly when supplied', () => {
    const result = addPointMarkerContainer(baseModel(), { role: 'activate', attachedNodeId: 'a', sequenceOrder: 42 });
    expect(result.containers.at(-1)!.sequenceOrder).toBe(42);
  });

  it('when sequenceOrder is omitted, assigns one greater than every existing container sequenceOrder', () => {
    const model = baseModel();
    model.containers[0].sequenceOrder = 5;
    const result = addPointMarkerContainer(model, { role: 'activate', attachedNodeId: 'a' });
    const added = result.containers.at(-1)!;
    expect(added.sequenceOrder).toBeDefined();
    expect(added.sequenceOrder!).toBeGreaterThan(5);
  });

  it('does not validate that attachedNodeId references an existing node', () => {
    const result = addPointMarkerContainer(baseModel(), { role: 'activate', attachedNodeId: 'does-not-exist' });
    expect(result.containers.at(-1)!.attachedNodeIds).toEqual(['does-not-exist']);
  });

  // canvas-2s6.2: a real bug found while wiring the canvas's own Activate/Deactivate button —
  // "after everything on the timeline" must consider EDGES (messages), not just containers, or a
  // diagram with messages but no other point-marker/block containers yet always computed maxOrder
  // -1 and placed the new marker at order 0, visually before every existing message.
  it('when sequenceOrder is omitted, also considers existing EDGE sequenceOrder, not containers alone', () => {
    const model = baseModel();
    model.edges[0].sequenceOrder = 0;
    model.edges[1].sequenceOrder = 7;
    // No container has a sequenceOrder at all — before the fix this alone would compute maxOrder
    // -1 and assign the new marker order 0, colliding with/preceding edge e2's own order 7.
    const result = addPointMarkerContainer(model, { role: 'activate', attachedNodeId: 'a' });
    expect(result.containers.at(-1)!.sequenceOrder).toBe(8);
  });

  it('when both containers and edges have a sequenceOrder, uses the true maximum across both', () => {
    const model = baseModel();
    model.containers[0].sequenceOrder = 3;
    model.edges[0].sequenceOrder = 0;
    model.edges[1].sequenceOrder = 10;
    const result = addPointMarkerContainer(model, { role: 'activate', attachedNodeId: 'a' });
    expect(result.containers.at(-1)!.sequenceOrder).toBe(11);
  });

  it('leaves every existing node, edge, and container untouched', () => {
    const model = baseModel();
    const result = addPointMarkerContainer(model, { role: 'activate', attachedNodeId: 'a' });
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges).toEqual(model.edges);
    expect(result.containers.slice(0, model.containers.length)).toEqual(model.containers);
  });

  it('does not mutate the input model', () => {
    const model = baseModel();
    const snapshot = JSON.parse(JSON.stringify(model));
    addPointMarkerContainer(model, { role: 'activate', attachedNodeId: 'a' });
    expect(model).toEqual(snapshot);
  });
});

describe('setSequenceAutonumber', () => {
  it('sets the bare form when enabled with no start/step', () => {
    const result = setSequenceAutonumber(baseModel(), { enabled: true });
    expect(result.sequenceAutonumber).toEqual({ start: undefined, step: undefined });
  });

  it('sets start/step when enabled with both given', () => {
    const result = setSequenceAutonumber(baseModel(), { enabled: true, start: 10, step: 5 });
    expect(result.sequenceAutonumber).toEqual({ start: 10, step: 5 });
  });

  it('clears sequenceAutonumber back to unset when disabled', () => {
    let model = baseModel();
    model = setSequenceAutonumber(model, { enabled: true, start: 10, step: 5 });
    const result = setSequenceAutonumber(model, { enabled: false });
    expect(result.sequenceAutonumber).toBeUndefined();
  });

  it('disabling when already unset is a no-op', () => {
    const model = baseModel();
    expect(setSequenceAutonumber(model, { enabled: false })).toEqual(model);
  });

  it('leaves nodes, edges, and containers untouched', () => {
    const model = baseModel();
    const result = setSequenceAutonumber(model, { enabled: true, start: 1, step: 1 });
    expect(result.nodes).toEqual(model.nodes);
    expect(result.edges).toEqual(model.edges);
    expect(result.containers).toEqual(model.containers);
  });
});
