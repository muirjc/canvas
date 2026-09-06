import type { DiagramContainer, DiagramNode, Position, Size } from './diagram-model.js';
import { nodeSize } from '../render/svg-renderer.js';

// canvas-m0g: every DSL parser with nestable containers (C4 boundaries, UML namespaces, flowchart
// subgraphs) placed every node/container from ONE flat, shared, sequential auto-position counter
// with zero awareness of parentContainerId/containerId — a container's own rendered box never
// actually enclosed its children; whether one visually overlapped another was pure coincidence
// (confirmed live against the reported bank-boundary C4 example: parentContainerId chains parsed
// correctly, but position placed a child container 400px to the right of its own parent). This
// replaces that flat counter with a real containment-aware layout: a two-pass (bottom-up sizing,
// then top-down absolute placement) simple flow layout with wrapping — not a full dagre
// compound-graph/constraint solve (canvas-esn's own "an explicit fast-follow... the dagre wiki
// doesn't document that feature in enough depth to commit to without its own spike" judgment call
// applies equally here), just enough to guarantee the one real invariant that was missing: every
// container's box strictly encloses its own direct AND indirect children, at every nesting depth.

const PADDING = 20;
const HEADER_HEIGHT = 30;
const SIBLING_GAP = 20;
const MAX_ROW_WIDTH = 900;
const EMPTY_CONTAINER_MIN_SIZE: Size = { width: 160, height: 100 };

interface LayoutItem {
  id: string;
  isContainer: boolean;
  size: Size;
}

/**
 * Lays out every node/container passed in (already-constructed model objects minus a real
 * `position`) so that every container's own computed position+size encloses its direct children
 * (nodes and/or nested containers), recursively to arbitrary depth, and siblings never overlap.
 *
 * Pure function — does not mutate its inputs; callers (each DSL parser's own auto-position
 * fallback) apply the returned positions/sizes themselves. `nodes`/`containers` should be the
 * FULL set that needs auto-positioning (typically: everything with no front-matter position) —
 * mixing in already-positioned elements is not attempted here (see research note in the calling
 * parsers): auto-positioned elements are laid out in their own coordinate space starting fresh
 * from `originX`/`originY`, independent of whatever already has a real stored position, matching
 * the flat counter's own pre-existing behavior of never checking for overlap with those either.
 */
export function computeContainmentLayout(
  nodes: DiagramNode[],
  containers: DiagramContainer[],
  originX = 40,
  originY = 40,
): { nodePositions: Map<string, Position>; containerPositions: Map<string, Position>; containerSizes: Map<string, Size> } {
  const nodePositions = new Map<string, Position>();
  const containerPositions = new Map<string, Position>();
  const containerSizes = new Map<string, Size>();

  const childContainersByParent = new Map<string | undefined, DiagramContainer[]>();
  for (const container of containers) {
    const list = childContainersByParent.get(container.parentContainerId) ?? [];
    list.push(container);
    childContainersByParent.set(container.parentContainerId, list);
  }
  const childNodesByContainer = new Map<string | undefined, DiagramNode[]>();
  for (const node of nodes) {
    const list = childNodesByContainer.get(node.containerId) ?? [];
    list.push(node);
    childNodesByContainer.set(node.containerId, list);
  }

  // Post-order: a container's own size can only be known once every descendant is laid out.
  // Recursion depth is bounded by real nesting depth (a handful of levels in any real diagram —
  // C4's own Boundary/Deployment_Node nesting, this bug's own motivating case, included).
  function layout(containerId: string | undefined, atX: number, atY: number): Size {
    const childContainers = childContainersByParent.get(containerId) ?? [];
    const childNodes = childNodesByContainer.get(containerId) ?? [];
    const isRoot = containerId === undefined;
    const headerHeight = isRoot ? 0 : HEADER_HEIGHT;

    const items: LayoutItem[] = [
      ...childContainers.map((c): LayoutItem => ({ id: c.id, isContainer: true, size: { width: 0, height: 0 } })),
      ...childNodes.map((n): LayoutItem => ({ id: n.id, isContainer: false, size: nodeSize(n) })),
    ];
    // Declaration order: containers and nodes each already preserve their own array order above;
    // interleave by whichever original array index is smaller so the visual flow roughly matches
    // the order things were declared in the source DSL (nodes and containers are separate arrays
    // on DiagramModel, so a byte-for-byte original interleaving isn't recoverable here — this is a
    // reasonable approximation, not a claim of exact source-order fidelity).
    items.sort((a, b) => {
      const aIdx = a.isContainer ? childContainers.findIndex((c) => c.id === a.id) : nodes.findIndex((n) => n.id === a.id);
      const bIdx = b.isContainer ? childContainers.findIndex((c) => c.id === b.id) : nodes.findIndex((n) => n.id === b.id);
      return aIdx - bIdx;
    });

    let cursorX = atX + PADDING;
    let cursorY = atY + headerHeight + PADDING;
    let rowHeight = 0;
    let maxRight = cursorX;

    for (const item of items) {
      // A child container's own box starts exactly at this row's current cursor (cursorX,
      // cursorY) — `layout()` adds the child's own HEADER_HEIGHT/PADDING internally when laying
      // out ITS OWN children, so the (x, y) passed in here already IS the child container's own
      // rendered position; no further adjustment needed.
      const size = item.isContainer ? layout(item.id, cursorX, cursorY) : item.size;
      if (item.isContainer) {
        containerPositions.set(item.id, { x: cursorX, y: cursorY });
        containerSizes.set(item.id, size);
      } else {
        nodePositions.set(item.id, { x: cursorX, y: cursorY });
      }
      cursorX += size.width + SIBLING_GAP;
      rowHeight = Math.max(rowHeight, size.height);
      maxRight = Math.max(maxRight, cursorX - SIBLING_GAP);
      if (cursorX - atX > MAX_ROW_WIDTH) {
        cursorX = atX + PADDING;
        cursorY += rowHeight + SIBLING_GAP;
        rowHeight = 0;
      }
    }

    // A real (non-root) container with no children yet still needs a sensible floor size — the
    // virtual root has no such need (its own returned size is never used as anyone's box).
    if (!isRoot && items.length === 0) {
      return EMPTY_CONTAINER_MIN_SIZE;
    }
    const contentBottom = cursorY + rowHeight;
    return { width: maxRight - atX + PADDING, height: contentBottom - atY + PADDING };
  }

  // Top-level pass: containers/nodes with no parent at all.
  layout(undefined, originX, originY);

  return { nodePositions, containerPositions, containerSizes };
}
