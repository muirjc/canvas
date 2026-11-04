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
export const AUTO_LAYOUT_FAMILIES = ['flowchart', 'c4', 'erd', 'uml', 'architecture', 'state'] as const;

/** Families whose DSL has a `direction` the chosen layout direction is written back to. */
const FAMILIES_WITH_DIRECTION = new Set(['flowchart', 'erd', 'uml', 'state']);

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
/** canvas-1bty.15.9: dagre keeps nodes in plain objects, so an id like `constructor` or `__proto__` broke
 *  it; a prefixed key is never an Object.prototype member, and keeps the ids' order (so layouts don't move). */
const dagreKey = (id: string): string => `#${id}`;

export function autoLayout(model: DiagramModel, direction?: FlowchartDirection, family = 'flowchart'): DiagramModel {
  if (!supportsAutoLayout(family)) return model;
  return anchorToPins(model, family === 'architecture' ? architectureAutoLayout(model) : layoutWithDagre(model, direction, family));
}

/** The shapes and groups a model pins (canvas-rqm6): ids it has, each once, in order. */
export function pinnedElementIds(model: Pick<DiagramModel, 'nodes' | 'containers' | 'pinned'>): string[] {
  if (!Array.isArray(model.pinned)) return [];
  const known = new Set<string>([...model.nodes.map((n) => n.id), ...model.containers.map((c) => c.id)]);
  return [...new Set(model.pinned.filter((id) => typeof id === 'string' && known.has(id)))];
}

/**
 * canvas-rqm6: keeps pinned shapes and groups where they were. The new layout is shifted by the
 * pins' average move (rounded), so with one pin everything is arranged around it; then every pin
 * goes back exactly where it was, a pinned group with its size and everything inside it. With
 * several pins far apart, a pin can end up on top of another shape (decided with the user).
 */
function anchorToPins(model: DiagramModel, laid: DiagramModel): DiagramModel {
  const pins = pinnedElementIds(model);
  if (pins.length === 0) return laid;
  const before = new Map<string, Position | undefined>([
    ...model.nodes.map((n): [string, Position | undefined] => [n.id, n.position]),
    ...model.containers.map((c): [string, Position | undefined] => [c.id, c.position]),
  ]);
  const after = new Map<string, Position | undefined>([
    ...laid.nodes.map((n): [string, Position | undefined] => [n.id, n.position]),
    ...laid.containers.map((c): [string, Position | undefined] => [c.id, c.position]),
  ]);
  let sumX = 0;
  let sumY = 0;
  let counted = 0;
  for (const id of pins) {
    const from = before.get(id);
    const to = after.get(id);
    if (!from || !to) continue;
    sumX += from.x - to.x;
    sumY += from.y - to.y;
    counted += 1;
  }
  const dx = counted > 0 ? Math.round(sumX / counted) : 0;
  const dy = counted > 0 ? Math.round(sumY / counted) : 0;

  // What stays: the pins, and everything inside a pinned group (at any depth).
  const pinned = new Set(pins);
  const parentOf = new Map<string, string | undefined>([
    ...model.containers.map((c): [string, string | undefined] => [c.id, c.parentContainerId]),
    ...model.nodes.map((n): [string, string | undefined] => [n.id, n.containerId]),
  ]);
  const stays = (id: string): boolean => {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !seen.has(current)) {
      if (pinned.has(current)) return true;
      seen.add(current);
      current = parentOf.get(current);
    }
    return false;
  };
  // Auto Layout changes only positions and group sizes, so what stays is simply the element as it was.
  const originalContainers = new Map(model.containers.map((c) => [c.id, c]));
  const originalNodes = new Map(model.nodes.map((n) => [n.id, n]));
  return {
    ...laid,
    nodes: laid.nodes.map((node) => {
      const original = originalNodes.get(node.id);
      if (original && stays(node.id)) return original;
      return node.position ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node;
    }),
    containers: laid.containers.map((container) => {
      const original = originalContainers.get(container.id);
      if (original && stays(container.id)) return original;
      return container.position ? { ...container, position: { x: container.position.x + dx, y: container.position.y + dy } } : container;
    }),
  };
}

function layoutWithDagre(model: DiagramModel, direction: FlowchartDirection | undefined, family: string): DiagramModel {

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

    const rankdir = toDagreRankDir(levelDirection);

    // canvas-rqm6: C4's side hints. One along the layout's direction orients its connector for
    // ranking; one across it puts the two items side by side in a line (a row when the layout
    // runs top-down, a column when it runs across), which dagre then places as one box.
    const lineOf = buildLines(model, level, rankdir, atLevel, sizeOf);
    const across = rankdir === 'TB' || rankdir === 'BT' ? 'width' : 'height';
    const lineSizes = new Map<string, Size>();
    const offsets = new Map<string, number>();
    for (const line of new Set(lineOf.values())) {
      let length = 0;
      let depth = 0;
      for (const id of line) {
        const size = sizeOf.get(id)!;
        offsets.set(id, length);
        length += size[across] + DEFAULT_NODESEP;
        depth = Math.max(depth, across === 'width' ? size.height : size.width);
      }
      length -= DEFAULT_NODESEP;
      lineSizes.set(line[0], across === 'width' ? { width: length, height: depth } : { width: depth, height: length });
    }
    const repOf = (id: string): string => lineOf.get(id)?.[0] ?? id;

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir, nodesep: DEFAULT_NODESEP, ranksep: DEFAULT_RANKSEP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of children) {
      const rep = repOf(id);
      if (rep !== id) continue;
      g.setNode(dagreKey(id), { ...(lineSizes.get(id) ?? sizeOf.get(id)!) });
    }
    const seenEdges = new Set<string>();
    const rank = (from: string, to: string) => {
      const a = repOf(from);
      const b = repOf(to);
      if (a === b) return;
      const key = `${a}->${b}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      g.setEdge(dagreKey(a), dagreKey(b));
    };
    for (const edge of model.edges) {
      // Only connectors whose ends both sit inside this level rank its items.
      const from = atLevel(edge.sourceId, level);
      const to = atLevel(edge.targetId, level);
      if (!from || !to || from === to) continue;
      if (hintRole(edge.layoutHint, rankdir) === 'backward') rank(to, from);
      else rank(from, to);
    }
    for (const hint of model.layoutHints ?? []) {
      const from = atLevel(hint.from, level);
      const to = atLevel(hint.to, level);
      if (!from || !to || from === to || !sizeOf.has(from) || !sizeOf.has(to)) continue;
      const role = hintRole(hint.direction, rankdir);
      if (role === 'forward') rank(from, to);
      else if (role === 'backward') rank(to, from);
    }
    // canvas-p2g8.2: useDynamic false, or dagre carries _oldGraph/_rawOldNodes from its previous call into this one
    // (edge reversal and ordering hints), so a layout depended on what the tab had laid out before.
    if (children.length > 0) dagre.layout(g, { useDynamic: false });

    const positions = new Map<string, Position>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of children) {
      const size = sizeOf.get(id)!;
      const rep = repOf(id);
      const box = lineSizes.get(rep) ?? size;
      const laid = g.node(dagreKey(rep));
      let x = (laid?.x ?? box.width / 2) - box.width / 2;
      let y = (laid?.y ?? box.height / 2) - box.height / 2;
      if (lineOf.has(id)) {
        // A member of a line: its place along the line, centred across it.
        if (across === 'width') {
          x += offsets.get(id)!;
          y += (box.height - size.height) / 2;
        } else {
          x += (box.width - size.width) / 2;
          y += offsets.get(id)!;
        }
      }
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

type HintRole = 'forward' | 'backward' | 'after' | 'before';

/** canvas-rqm6: what a side hint means in a layout running `rankdir`: along it (the target ranks
 *  after the source, or before it) or across it (the target goes after or before the source in a
 *  row or column). Undefined for no hint, or a value that isn't a side. */
function hintRole(direction: string | undefined, rankdir: 'TB' | 'BT' | 'LR' | 'RL'): HintRole | undefined {
  const vertical = rankdir === 'TB' || rankdir === 'BT';
  switch (direction) {
    case 'down':
      return vertical ? (rankdir === 'TB' ? 'forward' : 'backward') : 'after';
    case 'up':
      return vertical ? (rankdir === 'TB' ? 'backward' : 'forward') : 'before';
    case 'right':
      return vertical ? 'after' : rankdir === 'LR' ? 'forward' : 'backward';
    case 'left':
      return vertical ? 'before' : rankdir === 'LR' ? 'backward' : 'forward';
    default:
      return undefined;
  }
}

/**
 * canvas-rqm6: the rows (or columns) a level's across-the-layout hints ask for: each item in one
 * maps to the whole line, in order. Hints are taken in order (connectors first, then Lay_*); one
 * joins two lines end to end, the target's after the source's or before it, which keeps every
 * hint already taken. A hint between two items already in one line is skipped, so contradicting
 * hints can't loop.
 */
function buildLines(
  model: DiagramModel,
  level: string | undefined,
  rankdir: 'TB' | 'BT' | 'LR' | 'RL',
  atLevel: (id: string, level: string | undefined) => string | undefined,
  sizeOf: Map<string, Size>,
): Map<string, string[]> {
  const lineOf = new Map<string, string[]>();
  const hints = [
    ...model.edges.map((edge) => ({ from: edge.sourceId, to: edge.targetId, direction: edge.layoutHint as string | undefined })),
    ...(model.layoutHints ?? []),
  ];
  for (const hint of hints) {
    const role = hintRole(hint.direction, rankdir);
    if (role !== 'after' && role !== 'before') continue;
    const from = atLevel(hint.from, level);
    const to = atLevel(hint.to, level);
    if (!from || !to || from === to || !sizeOf.has(from) || !sizeOf.has(to)) continue;
    const a = lineOf.get(from) ?? [from];
    const b = lineOf.get(to) ?? [to];
    if (a === b) continue;
    const joined = role === 'after' ? [...a, ...b] : [...b, ...a];
    for (const id of joined) lineOf.set(id, joined);
  }
  return lineOf;
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
