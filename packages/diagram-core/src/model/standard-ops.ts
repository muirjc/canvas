import type { DiagramModel, DiagramNode, ElementId, Position } from './diagram-model.js';
import { addNode, updateEdgeArrowStyle, updateEdgeStyle, updateNodeRole, updateNodeStyle } from './diagram-ops.js';
import type { ConnectorRule, ElementKind } from '../standards/schema.js';
import { connectorDefaults, isApprovedColor, kindDefaults } from '../standards/kinds.js';

export interface AddElementOfKindResult {
  model: DiagramModel;
  nodeId: ElementId;
}

function patchNode(model: DiagramModel, nodeId: ElementId, patch: Partial<DiagramNode>): DiagramModel {
  return { ...model, nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
}

/** Sets or clears `external` -- clearing removes the key rather than storing `false`. */
function withExternal(model: DiagramModel, nodeId: ElementId, external: boolean | undefined): DiagramModel {
  return {
    ...model,
    nodes: model.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const { external: _drop, ...rest } = n;
      return external ? { ...rest, external: true } : rest;
    }),
  };
}

/**
 * canvas-tfr: adds a new node of `kind` -- role (+ `external`), the kind's default (first) shape
 * and default (first) fill/stroke swatch applied. Built on addNode/updateNodeRole/updateNodeStyle.
 * Pure: returns a new model, never mutates the input.
 */
export function addElementOfKind(
  model: DiagramModel,
  kind: ElementKind,
  opts?: { label?: string; position?: Position },
): AddElementOfKindResult {
  const defaults = kindDefaults(kind);
  let next = addNode(model, { shape: defaults.shape ?? 'rectangle', label: opts?.label ?? kind.label });
  const nodeId = next.nodes[next.nodes.length - 1].id;
  next = updateNodeRole(next, nodeId, defaults.role);
  next = withExternal(next, nodeId, defaults.external);
  if (defaults.style) next = updateNodeStyle(next, nodeId, defaults.style);
  if (opts?.position) next = patchNode(next, nodeId, { position: opts.position });
  return { model: next, nodeId };
}

/**
 * canvas-tfr: re-kinds an existing node. Sets role + `external`. Keeps the node's current shape if
 * the kind allows it (or the kind's shape list is empty), otherwise switches to the default shape.
 * Keeps the current fill/stroke if already approved for the kind (case-insensitive), otherwise
 * applies the default swatch. Unknown nodeId returns the model unchanged.
 */
export function applyElementKind(model: DiagramModel, nodeId: ElementId, kind: ElementKind): DiagramModel {
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return model;
  const defaults = kindDefaults(kind);
  let next = updateNodeRole(model, nodeId, defaults.role);
  next = withExternal(next, nodeId, defaults.external);
  if (kind.shapes.length > 0 && !kind.shapes.includes(node.shape)) {
    next = patchNode(next, nodeId, { shape: kind.shapes[0] });
  }
  const fill = node.style?.fillColor;
  const stroke = node.style?.strokeColor;
  const approvedStrokes = kind.approvedStrokes ?? [];
  const patch = {
    ...(kind.approvedFills.length > 0 && !(fill && isApprovedColor(fill, kind.approvedFills)) ? { fillColor: kind.approvedFills[0] } : {}),
    ...(approvedStrokes.length > 0 && !(stroke && isApprovedColor(stroke, approvedStrokes)) ? { strokeColor: approvedStrokes[0] } : {}),
  };
  return Object.keys(patch).length > 0 ? updateNodeStyle(next, nodeId, patch) : next;
}

/**
 * canvas-tfr: applies a connector rule's defaults (first arrow, first line style, first stroke) to
 * an existing edge. Unknown edgeId returns the model unchanged.
 */
export function applyConnectorRule(model: DiagramModel, edgeId: ElementId, rule: ConnectorRule): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  const { arrow, lineStyle, strokeColor } = connectorDefaults(rule);
  let next = model;
  if (arrow !== undefined || lineStyle !== undefined) {
    next = updateEdgeArrowStyle(next, edgeId, { ...(arrow ? { arrow } : {}), ...(lineStyle ? { lineStyle } : {}) });
  }
  if (strokeColor) next = updateEdgeStyle(next, edgeId, { strokeColor });
  return next;
}
