import dagre from '@dagrejs/dagre';
import type { DiagramModel, FlowchartDirection, Position } from './diagram-model.js';
import { moveContainer } from './diagram-ops.js';
import { nodeSize, containerSize } from '../render/svg-renderer.js';

const DEFAULT_NODESEP = 50;
const DEFAULT_RANKSEP = 60;

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

/** Walks a container's `parentContainerId` chain up to the nearest ancestor with none. */
function topLevelContainerAncestor(containerId: string, parentOf: Map<string, string | undefined>): string {
  let current = containerId;
  for (;;) {
    const parent = parentOf.get(current);
    if (parent === undefined) return current;
    current = parent;
  }
}

/**
 * Auto-arranges a flowchart-family diagram's top-level nodes/containers using dagre's DAG ranking
 * algorithm, closing the gap `DiagramModel.direction`/`DiagramContainer.direction`'s own doc
 * comments flag ("does not yet drive auto-layout").
 *
 * v1 is intentionally FLAT: only elements with no container are laid out by dagre directly; a
 * container's own CONTENTS are not re-laid-out. `moveContainer` (`diagram-ops.ts`) already knows
 * how to shift a container and everything nested inside it (arbitrary depth) by a single delta
 * while preserving each member's relative position, so a top-level container is treated as one
 * sized unit for ranking purposes and repositioned via that same existing function afterward.
 * Full dagre compound-graph (`setParent`) support, which would lay out *inside* every container
 * too, is a deliberate fast-follow — the dagre wiki doesn't document that feature in enough depth
 * to commit to it here without its own spike.
 *
 * Edges are left untouched (still drawn as straight lines between the new positions by the
 * existing renderers) — only `position` fields change, so this never touches node/edge/label
 * content and needs no confirmation prompt, unlike a destructive operation such as delete.
 */
export function autoLayout(model: DiagramModel, direction?: FlowchartDirection): DiagramModel {
  const resolvedDirection = direction ?? model.direction ?? 'TD';

  const topLevelNodes = model.nodes.filter((n) => n.containerId === undefined);
  const topLevelContainers = model.containers.filter((c) => c.parentContainerId === undefined);

  // Nothing to arrange (e.g. an empty diagram) — still record the chosen direction so a
  // subsequently-added shape and a future Auto Layout run both see it.
  if (topLevelNodes.length === 0 && topLevelContainers.length === 0) {
    return { ...model, direction: resolvedDirection };
  }

  const parentOf = new Map(model.containers.map((c) => [c.id, c.parentContainerId]));

  // Every node maps to the id actually placed in the dagre graph: itself if top-level, otherwise
  // its top-level container ancestor (edges always reference node ids, never a container id
  // directly — confirmed against flowchart-parser.ts's resolveEdgeEndpoint/ensureNode).
  const dagreIdForNode = new Map<string, string>();
  for (const node of model.nodes) {
    dagreIdForNode.set(node.id, node.containerId === undefined ? node.id : topLevelContainerAncestor(node.containerId, parentOf));
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: toDagreRankDir(resolvedDirection), nodesep: DEFAULT_NODESEP, ranksep: DEFAULT_RANKSEP });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of topLevelNodes) {
    const { width, height } = nodeSize(node);
    g.setNode(node.id, { width, height });
  }
  for (const container of topLevelContainers) {
    const { width, height } = containerSize(container);
    g.setNode(container.id, { width, height });
  }

  // Edges wholly inside one container (both endpoints map to the same top-level id) don't inform
  // top-level ranking and are skipped; parallel top-level edges collapse to one (dagre's ranking
  // only needs to know an edge exists between the two, not how many).
  const seenEdges = new Set<string>();
  for (const edge of model.edges) {
    const from = dagreIdForNode.get(edge.sourceId);
    const to = dagreIdForNode.get(edge.targetId);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    g.setEdge(from, to);
  }

  dagre.layout(g);

  let next = model;
  for (const node of topLevelNodes) {
    const laidOut = g.node(node.id);
    if (!laidOut || laidOut.x === undefined || laidOut.y === undefined) continue;
    const { width, height } = nodeSize(node);
    const position: Position = { x: laidOut.x - width / 2, y: laidOut.y - height / 2 };
    next = { ...next, nodes: next.nodes.map((n) => (n.id === node.id ? { ...n, position } : n)) };
  }
  for (const container of topLevelContainers) {
    const laidOut = g.node(container.id);
    if (!laidOut || laidOut.x === undefined || laidOut.y === undefined) continue;
    const { width, height } = containerSize(container);
    const position: Position = { x: laidOut.x - width / 2, y: laidOut.y - height / 2 };
    next = moveContainer(next, container.id, position);
  }

  return { ...next, direction: resolvedDirection };
}
