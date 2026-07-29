import type {
  DiagramContainer,
  DiagramEdge,
  DiagramModel,
  DiagramNode,
  NodeShape,
  Position,
  Size,
} from './diagram-model.js';

/**
 * Pure operations over DiagramModel, shared by the canvas for shape deletion (User Story 2) and
 * label editing (User Story 1) — feature 002 — and by the canvas's manual add-shape/connect-mode
 * UI *and* the AI tool-calling layer (feature 004, research.md §1/§2). No I/O, no hidden state:
 * same result for the same input every time, matching the contract diagram-core already holds
 * itself to (Constitution I).
 */

function generateId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface AddNodeInput {
  shape: NodeShape;
  label?: string;
}

/**
 * Appends a new node with an auto-computed grid position — the same layout rule the canvas's
 * manual "Add Shape" button uses — defaulting `label` to `"New Node"` when omitted.
 */
export function addNode(model: DiagramModel, input: AddNodeInput): DiagramModel {
  const index = model.nodes.length;
  const node: DiagramNode = {
    id: generateId('n'),
    label: input.label ?? 'New Node',
    shape: input.shape,
    position: { x: 40 + (index % 5) * 160, y: 40 + Math.floor(index / 5) * 120 },
  };
  return { ...model, nodes: [...model.nodes, node] };
}

export interface AddEdgeInput {
  sourceId: string;
  targetId: string;
  label?: string;
}

/**
 * Appends a new edge between two node ids. Does not validate that `sourceId`/`targetId` reference
 * existing nodes — mirrors the canvas's existing manual connect-mode gesture, which has the same
 * property (consistent with every parser's "implicit node from edge endpoint" behavior).
 */
export function addEdge(model: DiagramModel, input: AddEdgeInput): DiagramModel {
  const edge: DiagramEdge = {
    id: generateId('e'),
    sourceId: input.sourceId,
    targetId: input.targetId,
    label: input.label,
  };
  return { ...model, edges: [...model.edges, edge] };
}

/**
 * Removes a node, every edge attached to it (FR-008 — no dangling connector reference), and —
 * if that was the node's container's last remaining member — the now-empty container (FR-010).
 * Removing a node id that isn't present is a no-op (deletion is idempotent from the caller's
 * perspective).
 */
export function removeNode(model: DiagramModel, nodeId: string): DiagramModel {
  const target = model.nodes.find((n) => n.id === nodeId);
  if (!target) return model;

  const remainingNodes = model.nodes.filter((n) => n.id !== nodeId);
  const remainingEdges = model.edges.filter((e) => e.sourceId !== nodeId && e.targetId !== nodeId);

  const containerId = target.containerId;
  const remainingContainers =
    containerId && !remainingNodes.some((n) => n.containerId === containerId)
      ? model.containers.filter((c) => c.id !== containerId)
      : model.containers;

  return { ...model, nodes: remainingNodes, edges: remainingEdges, containers: remainingContainers };
}

/** Removes a single connector without touching its endpoint nodes. No-op if edgeId is absent. */
export function removeEdge(model: DiagramModel, edgeId: string): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  return { ...model, edges: model.edges.filter((e) => e.id !== edgeId) };
}

/**
 * Renames a shape. Shapes always keep a non-empty label (consistent with 001's existing rename
 * behavior) — this is a precondition the caller (canvas UI) must uphold, not silently patched
 * here with a placeholder.
 */
export function updateNodeLabel(model: DiagramModel, nodeId: string, label: string): DiagramModel {
  if (label === '') {
    throw new Error('updateNodeLabel: shape labels must be non-empty');
  }
  return {
    ...model,
    nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, label } : n)),
  };
}

/** Sets a connector's label; an empty string clears it (FR-005). */
export function updateEdgeLabel(model: DiagramModel, edgeId: string, label: string): DiagramModel {
  return {
    ...model,
    edges: model.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)),
  };
}

/* ------------------------------------------------------------------------- *
 * Container operations (feature 006, User Story 2)
 *
 * Containers were previously assembled inline in the canvas component. These are the shared,
 * pure operations the canvas, the DSL, and any future AI tool-calling all route through — the
 * same consolidation feature 004 applied to addNode/addEdge.
 *
 * See specs/006-authoring-admin-console/contracts/diagram-core-container-ops.md.
 * ------------------------------------------------------------------------- */

/** Fallback container size. A container must ALWAYS carry a size: the flowchart serializer
 *  omits size-less containers from front-matter, so one would silently lose its position on the
 *  next parse — the "silent loss" Constitution I prohibits. */
const DEFAULT_CONTAINER_SIZE: Size = { width: 300, height: 200 };

export interface AddContainerInput {
  label?: string;
  position?: Position;
  size?: Size;
}

/** Appends a container. Creates no membership — shapes join by being assigned, not by geometry. */
export function addContainer(model: DiagramModel, input: AddContainerInput): DiagramModel {
  const index = model.containers.length;
  const container: DiagramContainer = {
    id: generateId('grp'),
    label: input.label ?? 'Container',
    position: input.position ?? { x: 40 + (index % 3) * 360, y: 40 + Math.floor(index / 3) * 260 },
    // Never conditional: see DEFAULT_CONTAINER_SIZE.
    size: input.size ?? DEFAULT_CONTAINER_SIZE,
  };
  return { ...model, containers: [...model.containers, container] };
}

/** Renames a container. Like shapes, containers always keep a non-empty label. */
export function updateContainerLabel(model: DiagramModel, containerId: string, label: string): DiagramModel {
  if (label === '') {
    throw new Error('updateContainerLabel: container labels must be non-empty');
  }
  return {
    ...model,
    containers: model.containers.map((c) => (c.id === containerId ? { ...c, label } : c)),
  };
}

/**
 * Moves a container, taking its contents with it (FR-009).
 *
 * Node positions in this model are absolute — there is no transform hierarchy — so "contents
 * travel with the container" can only mean rewriting member positions by the same delta. That is
 * what preserves each member's position *relative to* the container.
 *
 * Child containers cascade too. Creating nesting is out of scope for feature 006, but imported
 * diagrams may already contain it and moving a parent must not tear it apart.
 */
export function moveContainer(model: DiagramModel, containerId: string, position: Position): DiagramModel {
  const container = model.containers.find((c) => c.id === containerId);
  if (!container) return model;

  const dx = position.x - container.position.x;
  const dy = position.y - container.position.y;
  if (dx === 0 && dy === 0) return model;

  // Collect the container and every descendant, so nested members shift exactly once.
  const movedIds = new Set<string>([containerId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of model.containers) {
      if (c.parentContainerId && movedIds.has(c.parentContainerId) && !movedIds.has(c.id)) {
        movedIds.add(c.id);
        grew = true;
      }
    }
  }

  return {
    ...model,
    containers: model.containers.map((c) =>
      movedIds.has(c.id) ? { ...c, position: { x: c.position.x + dx, y: c.position.y + dy } } : c,
    ),
    nodes: model.nodes.map((n) =>
      n.containerId && movedIds.has(n.containerId)
        ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
        : n,
    ),
  };
}

/**
 * Resizes a container. Deliberately touches nothing else: members are neither moved nor resized
 * (FR-010), and membership does not change — shrinking a container below its contents must not
 * eject them, because membership is explicit rather than geometric.
 */
export function resizeContainer(model: DiagramModel, containerId: string, size: Size): DiagramModel {
  if (!model.containers.some((c) => c.id === containerId)) return model;
  return {
    ...model,
    containers: model.containers.map((c) => (c.id === containerId ? { ...c, size } : c)),
  };
}

/** Adds a shape to a container, replacing any previous membership (a shape belongs to at most
 *  one container, FR-012). The shape does not move. */
export function assignNodeToContainer(model: DiagramModel, nodeId: string, containerId: string): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  if (!model.containers.some((c) => c.id === containerId)) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, containerId } : n)),
  };
}

/** Removes a shape from whatever container it is in. The shape stays exactly where it is. */
export function removeNodeFromContainer(model: DiagramModel, nodeId: string): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const { containerId: _removed, ...rest } = n;
      return rest;
    }),
  };
}

/**
 * Removes a container and RELEASES its contents (FR-013).
 *
 * Deleting a container never deletes shapes: members are freed by clearing `containerId`, with
 * positions untouched, and child containers are re-parented rather than removed.
 */
export function removeContainer(model: DiagramModel, containerId: string): DiagramModel {
  if (!model.containers.some((c) => c.id === containerId)) return model;
  return {
    ...model,
    containers: model.containers
      .filter((c) => c.id !== containerId)
      .map((c) => {
        if (c.parentContainerId !== containerId) return c;
        const { parentContainerId: _detached, ...rest } = c;
        return rest;
      }),
    nodes: model.nodes.map((n) => {
      if (n.containerId !== containerId) return n;
      const { containerId: _released, ...rest } = n;
      return rest;
    }),
  };
}
