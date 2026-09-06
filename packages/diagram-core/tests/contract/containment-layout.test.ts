import { describe, expect, it } from 'vitest';
import { computeContainmentLayout } from '../../src/model/containment-layout.js';
import type { DiagramContainer, DiagramNode } from '../../src/model/diagram-model.js';

/**
 * canvas-m0g: every parser's flat, shared auto-position counter placed nodes/containers with zero
 * awareness of parentContainerId/containerId — confirmed live against a real bank-boundary C4
 * example where a container's rendered box never enclosed its own children. These assert the one
 * real invariant that was missing: a container's computed box strictly encloses every direct and
 * indirect child, at every nesting depth — not just "it doesn't throw".
 */
function encloses(parentPos: { x: number; y: number }, parentSize: { width: number; height: number }, childPos: { x: number; y: number }, childSize: { width: number; height: number }): boolean {
  return (
    childPos.x >= parentPos.x &&
    childPos.y >= parentPos.y &&
    childPos.x + childSize.width <= parentPos.x + parentSize.width &&
    childPos.y + childSize.height <= parentPos.y + parentSize.height
  );
}

const node = (id: string, containerId?: string): DiagramNode => ({
  id,
  label: id,
  shape: 'rectangle',
  position: { x: 0, y: 0 },
  containerId,
});

const container = (id: string, parentContainerId?: string): DiagramContainer => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  parentContainerId,
});

describe('computeContainmentLayout', () => {
  it('a direct child node is enclosed by its container', () => {
    const containers = [container('c1')];
    const nodes = [node('n1', 'c1')];
    const result = computeContainmentLayout(nodes, containers);
    const cPos = result.containerPositions.get('c1')!;
    const cSize = result.containerSizes.get('c1')!;
    const nPos = result.nodePositions.get('n1')!;
    expect(encloses(cPos, cSize, nPos, { width: 140, height: 60 })).toBe(true);
  });

  it('the reported bank-boundary shape: a container 3 levels deep is still enclosed by its own direct parent, transitively up to the root', () => {
    // b0 (outermost) > b1 > b2/b3 (siblings), each with one node.
    const containers = [container('b0'), container('b1', 'b0'), container('b2', 'b1'), container('b3', 'b1')];
    const nodes = [node('n1', 'b2'), node('n2', 'b3')];
    const result = computeContainmentLayout(nodes, containers);

    const pos = (id: string) => result.containerPositions.get(id)!;
    const size = (id: string) => result.containerSizes.get(id)!;

    expect(encloses(pos('b0'), size('b0'), pos('b1'), size('b1'))).toBe(true);
    expect(encloses(pos('b1'), size('b1'), pos('b2'), size('b2'))).toBe(true);
    expect(encloses(pos('b1'), size('b1'), pos('b3'), size('b3'))).toBe(true);
    expect(encloses(pos('b2'), size('b2'), result.nodePositions.get('n1')!, { width: 140, height: 60 })).toBe(true);
    expect(encloses(pos('b3'), size('b3'), result.nodePositions.get('n2')!, { width: 140, height: 60 })).toBe(true);
    // Transitively: b2/b3 are also fully within b0's own box (not just their direct parent b1).
    expect(encloses(pos('b0'), size('b0'), pos('b2'), size('b2'))).toBe(true);
    expect(encloses(pos('b0'), size('b0'), pos('b3'), size('b3'))).toBe(true);
  });

  it('sibling containers under the same parent do not overlap', () => {
    const containers = [container('parent'), container('a', 'parent'), container('b', 'parent')];
    const nodes = [node('n1', 'a'), node('n2', 'b')];
    const result = computeContainmentLayout(nodes, containers);
    const aPos = result.containerPositions.get('a')!;
    const aSize = result.containerSizes.get('a')!;
    const bPos = result.containerPositions.get('b')!;
    const bSize = result.containerSizes.get('b')!;
    // Non-overlap: one is fully to the left of the other, or fully above/below.
    const noOverlap =
      aPos.x + aSize.width <= bPos.x ||
      bPos.x + bSize.width <= aPos.x ||
      aPos.y + aSize.height <= bPos.y ||
      bPos.y + bSize.height <= aPos.y;
    expect(noOverlap).toBe(true);
  });

  it('an empty container (no children at all) still gets a well-formed, non-zero floor size', () => {
    const containers = [container('empty')];
    const result = computeContainmentLayout([], containers);
    const size = result.containerSizes.get('empty')!;
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  it('a node with no containerId at all is positioned independently of any container box', () => {
    const containers = [container('c1')];
    const nodes = [node('inside', 'c1'), node('outside')];
    const result = computeContainmentLayout(nodes, containers);
    const cPos = result.containerPositions.get('c1')!;
    const cSize = result.containerSizes.get('c1')!;
    const outsidePos = result.nodePositions.get('outside')!;
    // The top-level node must not be silently swallowed into the container's own box.
    const isOutside =
      outsidePos.x >= cPos.x + cSize.width ||
      outsidePos.x + 140 <= cPos.x ||
      outsidePos.y >= cPos.y + cSize.height ||
      outsidePos.y + 60 <= cPos.y;
    expect(isOutside).toBe(true);
  });

  it('is a pure function: does not mutate its inputs', () => {
    const containers = [container('c1')];
    const nodes = [node('n1', 'c1')];
    const before = JSON.stringify({ nodes, containers });
    computeContainmentLayout(nodes, containers);
    expect(JSON.stringify({ nodes, containers })).toBe(before);
  });
});
