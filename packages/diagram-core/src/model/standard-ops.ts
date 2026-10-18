import type { DiagramModel, DiagramNode, ElementId, NodeShape, Position } from './diagram-model.js';
import { addNode, updateEdgeArrowStyle, updateEdgeStyle, updateNodeRole, updateNodeStyle } from './diagram-ops.js';
import type { ConnectorRule, ElementKind, StandardRules } from '../standards/schema.js';
import { connectorDefaults, isApprovedColor, kindDefaults, tagsForKind } from '../standards/kinds.js';

export interface AddElementOfKindResult {
  model: DiagramModel;
  nodeId: ElementId;
}

function patchNode(model: DiagramModel, nodeId: ElementId, patch: Partial<DiagramNode>): DiagramModel {
  return { ...model, nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
}

/** canvas-7hp: sets the node's tags for `kind` (see tagsForKind); a no-op without the rules. */
function withKindTags(model: DiagramModel, nodeId: ElementId, kind: ElementKind, rules: StandardRules | undefined): DiagramModel {
  if (!rules) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const { tags: _drop, ...rest } = n;
      const tags = tagsForKind(n, kind, rules);
      return tags ? { ...rest, tags } : rest;
    }),
  };
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
  // canvas-7hp: `rules` (the active standard) lets the element carry a tag when its kind shares a
  // C4 role with other kinds; without it no tags are written, as before.
  opts?: { label?: string; position?: Position; fallbackShape?: NodeShape; rules?: StandardRules },
): AddElementOfKindResult {
  const defaults = kindDefaults(kind);
  // jmuir-dtu.28: a kind with no shape list falls back to the family's own element shape when the
  // caller knows it (an architecture service is 'icon'), else a plain rectangle.
  let next = addNode(model, { shape: defaults.shape ?? opts?.fallbackShape ?? 'rectangle', label: opts?.label ?? kind.label });
  const nodeId = next.nodes[next.nodes.length - 1].id;
  next = updateNodeRole(next, nodeId, defaults.role);
  next = withExternal(next, nodeId, defaults.external);
  next = withKindTags(next, nodeId, kind, opts?.rules);
  if (defaults.style) next = updateNodeStyle(next, nodeId, defaults.style);
  if (opts?.position) next = patchNode(next, nodeId, { position: opts.position });
  return { model: next, nodeId };
}

/**
 * canvas-tfr: re-kinds an existing node. Sets role + `external` (and, given `rules`, the kind tag --
 * canvas-7hp). Keeps the node's current shape if
 * the kind allows it (or the kind's shape list is empty), otherwise switches to the default shape.
 * Keeps the current fill/stroke if already approved for the kind (case-insensitive), otherwise
 * applies the default swatch. Unknown nodeId returns the model unchanged.
 */
export function applyElementKind(model: DiagramModel, nodeId: ElementId, kind: ElementKind, rules?: StandardRules): DiagramModel {
  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return model;
  const defaults = kindDefaults(kind);
  let next = updateNodeRole(model, nodeId, defaults.role);
  next = withExternal(next, nodeId, defaults.external);
  next = withKindTags(next, nodeId, kind, rules);
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
