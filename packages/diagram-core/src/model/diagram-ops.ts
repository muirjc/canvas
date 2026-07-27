import type { DiagramEdge, DiagramModel, DiagramNode, NodeShape } from './diagram-model.js';

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
