import dagre from '@dagrejs/dagre';
import type { DiagramContainer, DiagramModel, FlowchartDirection, Position, Size } from './diagram-model.js';
import { computeArchitectureLayout } from './architecture-layout.js';
import { nodeSize, containerSize } from '../render/svg-renderer.js';

const DEFAULT_NODESEP = 50;
const DEFAULT_RANKSEP = 60;
// Space between a group's edge and its contents, and the band at its top that holds its label.
// The same values computeContainmentLayout/computeArchitectureLayout use, so groups look alike.
const PADDING = 20;
const HEADER_HEIGHT = 30;
const ORIGIN: Position = { x: 40, y: 40 };

/** canvas-p2g8.1: the diagram families Auto Layout arranges. Sequence diagrams are laid out from
 *  their message order (computeSequenceLayout), never by position, so they're not included. */
export const AUTO_LAYOUT_FAMILIES = ['flowchart', 'c4', 'erd', 'uml', 'architecture'] as const;

/** Families whose DSL has a `direction` the chosen layout direction is written back to. */
const FAMILIES_WITH_DIRECTION = new Set(['flowchart', 'erd', 'uml']);

/** Families where the direction picker means something (architecture follows its own hints). */
export function autoLayoutUsesDirection(family: string): boolean {
  return family !== 'architecture';
}

export function supportsAutoLayout(family: string): boolean {
  return (AUTO_LAYOUT_FAMILIES as readonly string[]).includes(family);
}

function toDagreRankDir(direction: FlowchartDirection): 'TB' | 'BT' | 'LR' | 'RL' {
  switch (direction) {
    case 'LR':
      return 'LR';
    case 'RL':
      return 'RL';
    case 'BT':
      return 'BT';
    case 'TD':
    case 'TB':
    default:
      return 'TB';
  }
}

/** One group's (or the top level's) laid-out contents, relative to the group's own top-left. */
interface LevelLayout {
  size: Size;
  /** Direct children: node id or container id -> top-left relative to this level's origin. */
  positions: Map<string, Position>;
}

/**
 * canvas-p2g8.1: arranges a diagram with dagre, INSIDE every group as well as between them
 * (the v1 flowchart-only version, canvas-esn, only moved top-level items and kept each group's
 * contents as they were).
 *
 * Bottom-up, one level at a time: a group's own contents (shapes and nested groups) are laid out
 * first, in the group's own `direction` if it has one (a flowchart subgraph's `direction LR`),
 * and the group is sized to fit them; then its parent level treats it as one box. A connector
 * counts at the level where its two ends meet -- a connector from a shape in group A to a shape
 * in group B ranks A and B against each other. So every group encloses its contents, nothing
 * overlaps, and connected items follow the chosen direction.
 *
 * Architecture diagrams use computeArchitectureLayout instead, which follows their own placement
 * hints (each connector's anchor sides, `align row/column`). Sequence diagrams are returned
 * unchanged. Only positions (and group sizes) change -- never labels, shapes or connectors.
 */
export function autoLayout(model: DiagramModel, direction?: FlowchartDirection, family = 'flowchart'): DiagramModel {
  if (!supportsAutoLayout(family)) return model;
  if (family === 'architecture') return architectureAutoLayout(model);

  const resolvedDirection = direction ?? model.direction ?? 'TD';
  const withDirection = (m: DiagramModel): DiagramModel => (FAMILIES_WITH_DIRECTION.has(family) ? { ...m, direction: resolvedDirection } : m);
  if (model.nodes.length === 0 && model.containers.length === 0) return withDirection(model);

  // A container reference that doesn't exist (or a loop of groups) is treated as top level, so
  // nothing is ever left unplaced.
  const containerIds = new Set(model.containers.map((c) => c.id));
  const known = (id: string | undefined) => (id !== undefined && containerIds.has(id) ? id : undefined);
  const parentOf = new Map<string, string | undefined>();
  for (const container of model.containers) parentOf.set(container.id, known(container.parentContainerId));
  for (const container of model.containers) {
    const seen = new Set([container.id]);
    let level = parentOf.get(container.id);
    while (level !== undefined && !seen.has(level)) {
      seen.add(level);
      level = parentOf.get(level);
    }
    if (level !== undefined) parentOf.set(container.id, undefined);
  }
  for (const node of model.nodes) parentOf.set(node.id, known(node.containerId));

  const childrenOf = new Map<string | undefined, string[]>();
  for (const [id, parent] of parentOf) {
    const list = childrenOf.get(parent) ?? [];
    list.push(id);
    childrenOf.set(parent, list);
  }
  const containersById = new Map(model.containers.map((c) => [c.id, c]));
  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));

  /** The item at `level` that holds `id` (itself, or the ancestor group sitting directly in it). */
  const atLevel = (id: string, level: string | undefined): string | undefined => {
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      if (parentOf.get(current) === level) return current;
      current = parentOf.get(current);
    }
    return undefined;
  };

  const levels = new Map<string | undefined, LevelLayout>();

  const layoutLevel = (level: string | undefined): LevelLayout => {
    const children = childrenOf.get(level) ?? [];
    const sizeOf = new Map<string, Size>();
    for (const id of children) {
      if (containersById.has(id)) {
        const inner = layoutLevel(id);
        sizeOf.set(id, groupSize(containersById.get(id)!, inner));
      } else {
        sizeOf.set(id, nodeSize(nodesById.get(id)!));
      }
    }
    const levelDirection = (level !== undefined ? containersById.get(level)?.direction : undefined) ?? resolvedDirection;

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: toDagreRankDir(levelDirection), nodesep: DEFAULT_NODESEP, ranksep: DEFAULT_RANKSEP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of children) g.setNode(id, { ...sizeOf.get(id)! });
    const seenEdges = new Set<string>();
    for (const edge of model.edges) {
      // Only connectors whose ends both sit inside this level rank its items.
      const from = atLevel(edge.sourceId, level);
      const to = atLevel(edge.targetId, level);
      if (!from || !to || from === to) continue;
      const key = `${from}->${to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      g.setEdge(from, to);
    }
    if (children.length > 0) dagre.layout(g);

    const positions = new Map<string, Position>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of children) {
      const laid = g.node(id);
      const size = sizeOf.get(id)!;
      const x = (laid?.x ?? size.width / 2) - size.width / 2;
      const y = (laid?.y ?? size.height / 2) - size.height / 2;
      positions.set(id, { x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + size.width);
      maxY = Math.max(maxY, y + size.height);
    }
    // Normalise so the level's contents start at 0,0.
    for (const [id, p] of positions) positions.set(id, { x: p.x - minX, y: p.y - minY });
    const layout: LevelLayout = {
      size: children.length > 0 ? { width: maxX - minX, height: maxY - minY } : { width: 0, height: 0 },
      positions,
    };
    levels.set(level, layout);
    return layout;
  };

  const groupSize = (container: DiagramContainer, inner: LevelLayout): Size => {
    if (inner.positions.size === 0) return containerSize(container);
    return { width: inner.size.width + 2 * PADDING, height: inner.size.height + 2 * PADDING + HEADER_HEIGHT };
  };

  layoutLevel(undefined);

  // Top-down: turn each level's relative positions into absolute ones.
  const nodePositions = new Map<string, Position>();
  const containerPositions = new Map<string, Position>();
  const containerSizes = new Map<string, Size>();
  const place = (level: string | undefined, origin: Position) => {
    const layout = levels.get(level);
    if (!layout) return;
    for (const [id, relative] of layout.positions) {
      const absolute = { x: Math.round(origin.x + relative.x), y: Math.round(origin.y + relative.y) };
      const container = containersById.get(id);
      if (container) {
        containerPositions.set(id, absolute);
        const inner = levels.get(id)!;
        containerSizes.set(id, groupSize(container, inner));
        place(id, { x: absolute.x + PADDING, y: absolute.y + PADDING + HEADER_HEIGHT });
      } else {
        nodePositions.set(id, absolute);
      }
    }
  };
  place(undefined, ORIGIN);

  return withDirection(applyPositions(model, nodePositions, containerPositions, containerSizes));
}

function architectureAutoLayout(model: DiagramModel): DiagramModel {
  const layout = computeArchitectureLayout(model.nodes, model.containers, model.edges, model.architectureAlignments ?? [], ORIGIN.x, ORIGIN.y);
  return applyPositions(model, layout.nodePositions, layout.containerPositions, layout.containerSizes);
}

function applyPositions(
  model: DiagramModel,
  nodePositions: Map<string, Position>,
  containerPositions: Map<string, Position>,
  containerSizes: Map<string, Size>,
): DiagramModel {
  return {
    ...model,
    nodes: model.nodes.map((node) => {
      const position = nodePositions.get(node.id);
      return position ? { ...node, position } : node;
    }),
    containers: model.containers.map((container) => {
      const position = containerPositions.get(container.id);
      const size = containerSizes.get(container.id);
      return position || size ? { ...container, ...(position ? { position } : {}), ...(size ? { size } : {}) } : container;
    }),
  };
}
