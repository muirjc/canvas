import type { DiagramContainer, DiagramEdge, DiagramModel, DiagramNode, Position, Size } from './diagram-model.js';
import { nodeSize } from '../render/svg-renderer.js';

// jmuir-dtu.26: a fresh architecture-beta import used to place every service, junction AND group
// from one flat grid counter, and groups got no size, so a group's box never enclosed its
// services. canvas-m0g's computeContainmentLayout() fixes the enclosure half for C4/UML/flowchart,
// but architecture diagrams also carry real placement hints that a plain flow layout would ignore:
// an edge's anchor sides (`db:L -- R:server` means db sits to the right of server) and
// `align row/column`. Mermaid's own renderer lays these diagrams out from exactly those hints.
//
// So this is a small grid layout, done per container level, bottom-up:
//   1. Every edge is "lifted" to the level where its two endpoints meet: at that level each
//      endpoint is represented by itself or by whichever ancestor group sits directly in that
//      level. That is what makes an edge from a service in one group to a service in a sibling
//      group place the two GROUPS relative to each other.
//   2. Within a level, a breadth-first walk from each unplaced item assigns grid cells: an
//      anchored edge puts its neighbour one cell in the anchor's direction, `align` puts the next
//      id one cell right (row) or down (column), and an edge with no anchors puts it one cell
//      right. Stronger hints are walked first. A taken cell pushes the item further in the same
//      direction, so nothing ever overlaps.
//   3. Cells become pixels: each column is as wide as its widest item, each row as tall as its
//      tallest, and items are centered in their cell, so anchored neighbours line up on a shared
//      center line. Disconnected clusters are then flowed left to right, wrapping like
//      computeContainmentLayout does.
// Not a full constraint solver: contradictory hints (A right of B and B right of A) resolve by
// walk order, not by any notion of the "best" compromise.

const PADDING = 20;
const HEADER_HEIGHT = 30;
const CELL_GAP = 60;
const CLUSTER_GAP = 60;
const MAX_ROW_WIDTH = 900;
const EMPTY_GROUP_MIN_SIZE: Size = { width: 160, height: 100 };

type Direction = { dx: number; dy: number };
const SIDE: Record<'T' | 'B' | 'L' | 'R', Direction> = {
  T: { dx: 0, dy: -1 },
  B: { dx: 0, dy: 1 },
  L: { dx: -1, dy: 0 },
  R: { dx: 1, dy: 0 },
};
const RIGHT: Direction = { dx: 1, dy: 0 };
const DOWN: Direction = { dx: 0, dy: 1 };

// Walk order: anchored edges, then align, then edges with no anchors.
const ANCHORED = 0;
const ALIGNED = 1;
const LOOSE = 2;

interface Link { to: string; dir: Direction; strength: number }

export interface ArchitectureLayout {
  nodePositions: Map<string, Position>;
  containerPositions: Map<string, Position>;
  containerSizes: Map<string, Size>;
}

export function computeArchitectureLayout(
  nodes: DiagramNode[],
  containers: DiagramContainer[],
  edges: DiagramEdge[],
  alignments: NonNullable<DiagramModel['architectureAlignments']> = [],
  originX = 40,
  originY = 40,
): ArchitectureLayout {
  // The level each item lives in: its group, or undefined for top level.
  // A reference to a group that was never declared, or a loop of groups nested in each other,
  // is laid out at top level rather than left unplaced.
  const groupIds = new Set(containers.map((group) => group.id));
  const known = (id: string | undefined) => (id !== undefined && groupIds.has(id) ? id : undefined);
  const parentOf = new Map<string, string | undefined>();
  for (const group of containers) parentOf.set(group.id, known(group.parentContainerId));
  for (const node of nodes) parentOf.set(node.id, known(node.containerId));
  for (const group of containers) {
    const seen = new Set<string>([group.id]);
    let level = parentOf.get(group.id);
    while (level !== undefined && !seen.has(level)) {
      seen.add(level);
      level = parentOf.get(level);
    }
    if (level !== undefined) parentOf.set(group.id, undefined);
  }

  const ancestry = (id: string): (string | undefined)[] => {
    const chain: (string | undefined)[] = [];
    let level = parentOf.get(id);
    while (level !== undefined) {
      chain.push(level);
      level = parentOf.get(level);
    }
    chain.push(undefined);
    return chain;
  };

  // Which item represents `id` inside `level`: id itself, or its ancestor group sitting there.
  const representativeIn = (id: string, level: string | undefined): string => {
    let current = id;
    while (parentOf.get(current) !== level) current = parentOf.get(current)!;
    return current;
  };

  const linksByLevel = new Map<string | undefined, Map<string, Link[]>>();
  const addLink = (level: string | undefined, from: string, to: string, dir: Direction, strength: number) => {
    const levelLinks = linksByLevel.get(level) ?? new Map<string, Link[]>();
    linksByLevel.set(level, levelLinks);
    const push = (a: string, link: Link) => levelLinks.set(a, [...(levelLinks.get(a) ?? []), link]);
    push(from, { to, dir, strength });
    push(to, { to: from, dir: { dx: -dir.dx, dy: -dir.dy }, strength });
  };

  for (const edge of edges) {
    if (!parentOf.has(edge.sourceId) || !parentOf.has(edge.targetId) || edge.sourceId === edge.targetId) continue;
    const targetChain = new Set(ancestry(edge.targetId));
    const level = ancestry(edge.sourceId).find((candidate) => targetChain.has(candidate));
    const from = representativeIn(edge.sourceId, level);
    const to = representativeIn(edge.targetId, level);
    if (from === to) continue;
    // A source anchor names the side facing the target; a target anchor names the side facing
    // the source, so it points the opposite way.
    let dir = RIGHT;
    let strength = LOOSE;
    if (edge.sourceAnchor) {
      dir = SIDE[edge.sourceAnchor];
      strength = ANCHORED;
    } else if (edge.targetAnchor) {
      const side = SIDE[edge.targetAnchor];
      dir = { dx: -side.dx, dy: -side.dy };
      strength = ANCHORED;
    }
    addLink(level, from, to, dir, strength);
  }

  for (const alignment of alignments) {
    const dir = alignment.axis === 'row' ? RIGHT : DOWN;
    const ids = alignment.ids.filter((id) => parentOf.has(id));
    for (let i = 1; i < ids.length; i += 1) {
      // Mermaid only aligns siblings; ids from different levels are skipped rather than lifted.
      if (parentOf.get(ids[i]) !== parentOf.get(ids[i - 1])) continue;
      addLink(parentOf.get(ids[i]), ids[i - 1], ids[i], dir, ALIGNED);
    }
  }

  const childrenOf = new Map<string | undefined, { id: string; isGroup: boolean }[]>();
  // Declaration order, groups first.
  for (const item of [...containers.map((g) => ({ id: g.id, isGroup: true })), ...nodes.map((n) => ({ id: n.id, isGroup: false }))]) {
    const level = parentOf.get(item.id);
    childrenOf.set(level, [...(childrenOf.get(level) ?? []), item]);
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  // Offsets of each item relative to its own level's content origin, plus each group's size.
  const localOffsets = new Map<string, Position>();
  const groupSizes = new Map<string, Size>();

  function layoutLevel(level: string | undefined): Size {
    const items = childrenOf.get(level) ?? [];
    const sizes = new Map<string, Size>();
    for (const item of items) {
      if (item.isGroup) {
        const inner = layoutLevel(item.id);
        const size = inner.width === 0
          ? EMPTY_GROUP_MIN_SIZE
          : { width: inner.width + PADDING * 2, height: inner.height + HEADER_HEIGHT + PADDING * 2 };
        groupSizes.set(item.id, size);
        sizes.set(item.id, size);
      } else {
        sizes.set(item.id, nodeSize(nodesById.get(item.id)!));
      }
    }

    const links = linksByLevel.get(level) ?? new Map<string, Link[]>();
    const cell = new Map<string, { col: number; row: number }>();
    const clusters: string[][] = [];

    for (const seed of items) {
      if (cell.has(seed.id)) continue;
      const occupied = new Map<string, string>();
      const key = (col: number, row: number) => `${col},${row}`;
      const place = (id: string, col: number, row: number, dir: Direction) => {
        let c = col;
        let r = row;
        while (occupied.has(key(c, r))) {
          c += dir.dx;
          r += dir.dy;
        }
        cell.set(id, { col: c, row: r });
        occupied.set(key(c, r), id);
      };

      const members: string[] = [seed.id];
      place(seed.id, 0, 0, RIGHT);
      // Breadth-first, but each strength tier is drained before weaker links are followed, so an
      // anchored relationship anywhere in the cluster claims its cell before a loose one can.
      for (let strength = ANCHORED; strength <= LOOSE; strength += 1) {
        const queue = [...members];
        while (queue.length > 0) {
          const id = queue.shift()!;
          const here = cell.get(id)!;
          for (const link of links.get(id) ?? []) {
            if (link.strength > strength || cell.has(link.to)) continue;
            place(link.to, here.col + link.dir.dx, here.row + link.dir.dy, link.dir);
            members.push(link.to);
            queue.push(link.to);
          }
        }
      }
      clusters.push(members);
    }

    // Each cluster's cells become a pixel block; blocks then flow left to right with wrapping.
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    let maxRight = 0;
    let maxBottom = 0;
    for (const members of clusters) {
      const minCol = Math.min(...members.map((id) => cell.get(id)!.col));
      const minRow = Math.min(...members.map((id) => cell.get(id)!.row));
      const colWidths = new Map<number, number>();
      const rowHeights = new Map<number, number>();
      for (const id of members) {
        const { col, row } = cell.get(id)!;
        const size = sizes.get(id)!;
        colWidths.set(col - minCol, Math.max(colWidths.get(col - minCol) ?? 0, size.width));
        rowHeights.set(row - minRow, Math.max(rowHeights.get(row - minRow) ?? 0, size.height));
      }
      const colCount = Math.max(...colWidths.keys()) + 1;
      const rowCount = Math.max(...rowHeights.keys()) + 1;
      const colX: number[] = [];
      const rowY: number[] = [];
      let x = 0;
      for (let c = 0; c < colCount; c += 1) {
        colX.push(x);
        x += (colWidths.get(c) ?? 0) + CELL_GAP;
      }
      let y = 0;
      for (let r = 0; r < rowCount; r += 1) {
        rowY.push(y);
        y += (rowHeights.get(r) ?? 0) + CELL_GAP;
      }
      const blockWidth = x - CELL_GAP;
      const blockHeight = y - CELL_GAP;

      if (cursorX > 0 && cursorX + blockWidth > MAX_ROW_WIDTH) {
        cursorX = 0;
        cursorY += rowHeight + CLUSTER_GAP;
        rowHeight = 0;
      }
      for (const id of members) {
        const { col, row } = cell.get(id)!;
        const size = sizes.get(id)!;
        const c = col - minCol;
        const r = row - minRow;
        localOffsets.set(id, {
          x: cursorX + colX[c] + ((colWidths.get(c) ?? 0) - size.width) / 2,
          y: cursorY + rowY[r] + ((rowHeights.get(r) ?? 0) - size.height) / 2,
        });
      }
      maxRight = Math.max(maxRight, cursorX + blockWidth);
      maxBottom = Math.max(maxBottom, cursorY + blockHeight);
      rowHeight = Math.max(rowHeight, blockHeight);
      cursorX += blockWidth + CLUSTER_GAP;
    }
    return { width: maxRight, height: maxBottom };
  }

  layoutLevel(undefined);

  const nodePositions = new Map<string, Position>();
  const containerPositions = new Map<string, Position>();
  const containerSizes = new Map<string, Size>();
  const placeLevel = (level: string | undefined, contentX: number, contentY: number) => {
    for (const item of childrenOf.get(level) ?? []) {
      const offset = localOffsets.get(item.id);
      if (!offset) continue;
      const position = { x: contentX + offset.x, y: contentY + offset.y };
      if (item.isGroup) {
        containerPositions.set(item.id, position);
        containerSizes.set(item.id, groupSizes.get(item.id) ?? EMPTY_GROUP_MIN_SIZE);
        placeLevel(item.id, position.x + PADDING, position.y + HEADER_HEIGHT + PADDING);
      } else {
        nodePositions.set(item.id, position);
      }
    }
  };
  placeLevel(undefined, originX, originY);

  return { nodePositions, containerPositions, containerSizes };
}
