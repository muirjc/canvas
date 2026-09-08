import {
  isAllowedLinkHref,
  type ClassMember,
  type DiagramContainer,
  type DiagramEdge,
  type DiagramModel,
  type DiagramNode,
  type EntityAttribute,
  type FlowchartDirection,
  type NodeLink,
  type NodeShape,
  type NodeStyle,
  type Position,
  type Size,
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
  /** Omitted means a plain forward arrow (source -> target), same as always. 'both' draws an
   *  arrowhead at each end (canvas-7rr); 'none' draws no arrowhead at either end. A "reversed"
   *  connector needs no value here — it is just sourceId/targetId swapped by the caller. */
  arrow?: DiagramEdge['arrow'];
  /** ERD only: a plain arrowhead is not valid ER notation at all (real erDiagram relationships
   *  are drawn with crow's-foot cardinality glyphs on both ends, never a directional arrow) — a
   *  caller creating a connector in an ER diagram (the canvas's own connect-mode gesture) should
   *  always supply both, so the edge is ER-correct from the moment it exists rather than only
   *  after a save/reparse round-trip re-derives it from DEFAULT_CARDINALITY (erd.ts's own
   *  serialize-time fallback covers DSL *text* validity, not what the interactive canvas renders
   *  in the meantime — canvas-vcv follow-up). */
  erSourceCardinality?: string;
  erTargetCardinality?: string;
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
    arrow: input.arrow,
    erSourceCardinality: input.erSourceCardinality,
    erTargetCardinality: input.erTargetCardinality,
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

/**
 * jmuir-dzd.5: sets or clears a flowchart node's `click href` interaction — `link: null` clears
 * it entirely; a real `NodeLink` sets/replaces it wholesale (href is always required on the
 * interface itself, so there is no meaningful "partial" link to merge-patch, unlike StylePatch).
 *
 * Throws (mirrors updateNodeLabel's own empty-label precedent — a genuine precondition violation,
 * not a soft "id not found" no-op) when the href fails isAllowedLinkHref, rather than silently
 * storing an unusable link the export renderer would just as silently neutralize later: `link` is
 * also settable directly through this op (bypassing the flowchart parser's own identical check
 * entirely), so this is the ONE place that boundary is actually enforced for every non-DSL-import
 * caller (the canvas UI popup, and — should a future bead ever add one — an AI tool). Every
 * consumer must still independently re-check at its own trust boundary too (svg-renderer.ts's
 * wrapNodeLink does, as defense in depth) rather than assuming this check ran.
 */
export function setNodeLink(model: DiagramModel, nodeId: string, link: NodeLink | null): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  if (link !== null) {
    if (!isAllowedLinkHref(link.href)) {
      throw new Error(`setNodeLink: href must use "http://", "https://", or a relative path (got "${link.href}").`);
    }
    // jmuir-dzd.5 appsec review: dsl/flowchart-serializer.ts's serializeClickHref re-emits
    // href/tooltip inside a literal `"..."` DSL token with no escape mechanism at all (confirmed
    // against the parser's own `"([^"]*)"` capture — real Mermaid's click grammar has no quote-
    // escaping syntax to emit even if this file wanted to). A `"` would prematurely close that
    // token; a raw newline would inject an entirely separate DSL statement on the next line —
    // e.g. a second `click <otherNodeId> href "javascript:..."` line targeting a DIFFERENT node,
    // one whose own href was never itself passed to isAllowedLinkHref, defeating the scheme check
    // entirely on next reparse. Rejected here (not escaped) since there is no valid escaped form
    // to produce — matches this op's own "throw on a genuine precondition violation" convention,
    // not a soft no-op.
    if (/["\r\n]/.test(link.href) || (link.tooltip !== undefined && /["\r\n]/.test(link.tooltip))) {
      throw new Error(
        'setNodeLink: href/tooltip cannot contain a double-quote or a line break -- the DSL "click href" directive has no escape syntax for either.',
      );
    }
  }
  return {
    ...model,
    nodes: model.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      if (link === null) {
        const { link: _removed, ...rest } = n;
        return rest;
      }
      return { ...n, link };
    }),
  };
}

/** Sets a connector's label; an empty string clears it (FR-005). */
export function updateEdgeLabel(model: DiagramModel, edgeId: string, label: string): DiagramModel {
  return {
    ...model,
    edges: model.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)),
  };
}

export interface StylePatch {
  /** Omit a field to leave it untouched. `null` explicitly clears it back to unset (canvas-xig's
   *  Clear/Reset control) — distinct from omitting, which the AI tool-calling layer relies on to
   *  patch just one field at a time. */
  fillColor?: string | null;
  strokeColor?: string | null;
  strokeWidth?: number | null;
  strokeDasharray?: string | null;
  // canvas-2s6.7: fontFamily/fontSize were already real NodeStyle fields (diagram-model.ts) but
  // this patch type — the one shared path every mutation of a node/edge's style routes through,
  // canvas UI and AI tool-calling alike (Constitution I) — never carried either one, so neither
  // was actually settable from anywhere despite NodeStyle itself claiming to support them.
  fontFamily?: string | null;
  fontSize?: number | null;
}

/** Merges only the fields present in `patch` onto `existing`: omitted leaves the existing value
 *  untouched, an explicit `null` clears it, a real value sets it. */
function mergeStyle(existing: NodeStyle | undefined, patch: StylePatch): NodeStyle {
  const merged: NodeStyle = { ...existing };
  for (const key of ['fillColor', 'strokeColor', 'strokeWidth', 'strokeDasharray', 'fontFamily', 'fontSize'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else (merged[key] as typeof value) = value;
  }
  return merged;
}

/** Sets fill/stroke color and stroke width/dasharray on a node, merging onto any existing style
 *  (DSL `style`/`classDef` equivalents, now reachable from the canvas and the AI tool-calling
 *  layer too — feature 004 research.md §1/§2's shared-operation pattern). No-op for an unknown id,
 *  mirroring updateContainerLabel/resizeContainer rather than updateNodeLabel/updateEdgeLabel
 *  (which have no failure mode to guard, since any string is a valid label). */
export function updateNodeStyle(model: DiagramModel, nodeId: string, patch: StylePatch): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, style: mergeStyle(n.style, patch) } : n)),
  };
}

/** Sets fill/stroke color and stroke width/dasharray on an edge (DSL `linkStyle` equivalent). */
export function updateEdgeStyle(model: DiagramModel, edgeId: string, patch: StylePatch): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  return {
    ...model,
    edges: model.edges.map((e) => (e.id === edgeId ? { ...e, style: mergeStyle(e.style, patch) } : e)),
  };
}

/* ------------------------------------------------------------------------- *
 * Diagram-type-specific operations (010-ai-diagram-knowledge, User Story 2)
 *
 * Requests that only make sense for a specific diagram type (an ER attribute, a UML member/
 * relationship, a C4/sequence role) previously had no way to actually produce that family's real
 * structure through the AI tool-calling layer — only generic label/style edits existed. These
 * follow the same merge-patch / no-op-on-missing-id conventions updateNodeStyle/updateEdgeStyle
 * already established, so an AI-authored edit is indistinguishable from one made any other way.
 * ------------------------------------------------------------------------- */

/** Sets a node's semantic role (e.g. "person", "system", "container" — used by Standards
 *  validation and by C4/sequence's own role vocabulary). No-op for an unknown id. */
export function updateNodeRole(model: DiagramModel, nodeId: string, role: string): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, role } : n)),
  };
}

/** Replaces an ER entity's declared attributes wholesale (an attribute *list* is naturally
 *  replace-whole rather than patched, since reordering/removal needs the same call shape as
 *  addition) — passing `[]` clears every attribute rather than leaving the field untouched.
 *  No-op for an unknown id. */
export function updateEntityAttributes(
  model: DiagramModel,
  nodeId: string,
  attributes: EntityAttribute[],
): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, attributes } : n)),
  };
}

/** Replaces a UML class's declared members (attributes and methods) wholesale, same rationale as
 *  updateEntityAttributes. No-op for an unknown id. */
export function updateClassMembers(model: DiagramModel, nodeId: string, members: ClassMember[]): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, members } : n)),
  };
}

/** canvas-2s6.3: sets a UML class's `<<Stereotype>>` annotation; an empty string clears it back
 *  to unset, same "empty string clears" convention as updateEdgeLabel (stereotype is optional, so
 *  unlike updateNodeLabel/updateContainerLabel there is no non-empty invariant to enforce). No-op
 *  for an unknown id. */
export function updateNodeStereotype(model: DiagramModel, nodeId: string, stereotype: string): DiagramModel {
  if (!model.nodes.some((n) => n.id === nodeId)) return model;
  return {
    ...model,
    nodes: model.nodes.map((n) => (n.id === nodeId ? { ...n, umlStereotype: stereotype || undefined } : n)),
  };
}

export interface EdgeRelationKindPatch {
  /** Omit to leave untouched; `null` clears it back to unset; a value sets it — same convention
   *  as StylePatch below. */
  umlRelationKind?: DiagramEdge['umlRelationKind'] | null;
  sourceCardinality?: string | null;
  targetCardinality?: string | null;
}

/** Merge-patches a UML edge's relationship kind and cardinality labels, mirroring
 *  updateEdgeStyle's merge semantics. No-op for an unknown id. */
export function updateEdgeRelationKind(
  model: DiagramModel,
  edgeId: string,
  patch: EdgeRelationKindPatch,
): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  return {
    ...model,
    edges: model.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const next = { ...e };
      for (const key of ['umlRelationKind', 'sourceCardinality', 'targetCardinality'] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else (next[key] as typeof value) = value;
      }
      return next;
    }),
  };
}

export interface EdgeErCardinalityPatch {
  /** Omit to leave untouched; `null` clears it back to unset; a value sets it — same convention
   *  as EdgeRelationKindPatch above. */
  erSourceCardinality?: string | null;
  erTargetCardinality?: string | null;
}

/** canvas-2s6.4: merge-patches an ER edge's crow's-foot cardinality tokens, mirroring
 *  updateEdgeRelationKind's merge semantics exactly. Previously these could only ever be set at
 *  edge-creation time (the connect-mode picker) — no way to change an existing relationship's
 *  cardinality short of deleting and redrawing it. No-op for an unknown id. */
export function updateEdgeErCardinality(
  model: DiagramModel,
  edgeId: string,
  patch: EdgeErCardinalityPatch,
): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  return {
    ...model,
    edges: model.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const next = { ...e };
      for (const key of ['erSourceCardinality', 'erTargetCardinality'] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else (next[key] as typeof value) = value;
      }
      return next;
    }),
  };
}

export interface EdgeArrowStylePatch {
  arrow?: DiagramEdge['arrow'] | null;
  lineStyle?: DiagramEdge['lineStyle'] | null;
}

/** Merge-patches an edge's arrowhead/line rendering, mirroring updateEdgeStyle's merge semantics.
 *  No-op for an unknown id. */
export function updateEdgeArrowStyle(model: DiagramModel, edgeId: string, patch: EdgeArrowStylePatch): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  return {
    ...model,
    edges: model.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const next = { ...e };
      for (const key of ['arrow', 'lineStyle'] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else (next[key] as typeof value) = value;
      }
      return next;
    }),
  };
}

export interface EdgeArchitectureModifiersPatch {
  /** Omit to leave untouched; `null` clears it back to unset; a value sets it — same convention
   *  as EdgeRelationKindPatch/EdgeErCardinalityPatch above. */
  sourceIsGroup?: boolean | null;
  targetIsGroup?: boolean | null;
  sourceAnchor?: DiagramEdge['sourceAnchor'] | null;
  targetAnchor?: DiagramEdge['targetAnchor'] | null;
}

/** canvas-2s6.6: merge-patches an architecture edge's `{group}` escalation and `:T/B/L/R` anchor
 *  hints (dsl/architecture.ts), mirroring updateEdgeRelationKind's merge semantics exactly. Neither
 *  field is part of AddEdgeInput (unlike ER's erSourceCardinality/erTargetCardinality, which the
 *  connect-mode gesture supplies directly at creation) since they're rare enough not to warrant
 *  widening every other family's addEdge call site — the canvas's architecture-specific
 *  connect-mode picker instead applies this as a second "create then patch" step, the same
 *  composition UML's own relationship kind already uses. No-op for an unknown id. */
export function updateEdgeArchitectureModifiers(
  model: DiagramModel,
  edgeId: string,
  patch: EdgeArchitectureModifiersPatch,
): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  return {
    ...model,
    edges: model.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const next = { ...e };
      for (const key of ['sourceIsGroup', 'targetIsGroup', 'sourceAnchor', 'targetAnchor'] as const) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === null) delete next[key];
        else (next[key] as typeof value) = value;
      }
      return next;
    }),
  };
}

export interface AddPointMarkerContainerInput {
  role: 'activate' | 'deactivate';
  attachedNodeId: string;
  /** Omit to place it after everything currently on the timeline. */
  sequenceOrder?: number;
}

/**
 * Appends a sequence-diagram activation/deactivation marker, matching the exact
 * `DiagramContainer` shape `dsl/sequence.ts`'s own parser produces for `activate`/`deactivate`
 * (its `pushPointItem` helper) — an AI-authored activation becomes indistinguishable from a
 * DSL-parsed one. Does not validate that `attachedNodeId` references an existing node, mirroring
 * addEdge's same "implicit reference" precedent.
 */
export function addPointMarkerContainer(
  model: DiagramModel,
  input: AddPointMarkerContainerInput,
): DiagramModel {
  const index = model.containers.length;
  // canvas-2s6.2: a real bug found while wiring the canvas's own activate/deactivate button --
  // "after everything currently on the timeline" must mean the max sequenceOrder across BOTH
  // containers AND edges (messages are the majority of any real timeline's items). Considering
  // containers alone meant a diagram with messages but no other containers yet always computed
  // maxOrder -1, placing the new marker at order 0 -- visually BEFORE every existing message,
  // not after them. Unreachable via the AI tool's own unit tests (empty-model fixtures never
  // exercised a populated timeline) until this bead's UI wiring made it reachable interactively.
  const maxOrder = [...model.containers, ...model.edges].reduce(
    (max, item) => (item.sequenceOrder !== undefined && item.sequenceOrder > max ? item.sequenceOrder : max),
    -1,
  );
  const container: DiagramContainer = {
    id: generateId('pt'),
    label: '',
    role: input.role,
    attachedNodeIds: [input.attachedNodeId],
    position: { x: 40 + (index % 3) * 360, y: 40 + Math.floor(index / 3) * 260 },
    sequenceOrder: input.sequenceOrder ?? maxOrder + 1,
  };
  return { ...model, containers: [...model.containers, container] };
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
  /** canvas-2s6.1: semantic kind — mirrors DiagramContainer.role's own vocabulary (see its doc
   *  comment for the full per-family list: sequence's block/note/box roles, UML's namespace/note,
   *  C4's five boundary kinds, ...). Omitted means a plain, role-less container — exactly today's
   *  pre-existing behavior, so every current caller (groupSelected, groupIntoContainer) is
   *  unaffected until it opts in. */
  role?: string;
  /** canvas-2s6.1: nests the new container inside an existing one (C4/UML nesting). Omitted means
   *  top-level, exactly today's pre-existing behavior. */
  parentContainerId?: string;
  /** canvas-2s6.1: sequence notes (role starts with 'note-') and UML's attached 'note' form need
   *  this at creation to be meaningful — see DiagramContainer.attachedNodeIds. Every other role
   *  ignores it. */
  attachedNodeIds?: string[];
  /** canvas-2s6.1: sequence diagrams only — this container's own position on the message
   *  timeline (mirrors DiagramEdge.sequenceOrder; see computeSequenceLayout). Omitted means unset,
   *  correct for every role that sits outside the timeline entirely ('box', every non-sequence
   *  role) — the caller (not this pure op) is responsible for computing "append at the end of the
   *  timeline" the same way addPointMarkerContainer's own maxOrder+1 already does, since that's a
   *  read of the current model the caller already has in hand. */
  sequenceOrder?: number;
  /** canvas-2s6.2: sequence `rect <color> ... end` needs its color set at creation time (there is
   *  no dedicated container-style op to "create then patch" onto, unlike node/edge style) — every
   *  other role ignores this. */
  style?: NodeStyle;
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
    role: input.role,
    parentContainerId: input.parentContainerId,
    attachedNodeIds: input.attachedNodeIds,
    sequenceOrder: input.sequenceOrder,
    style: input.style,
  };
  return { ...model, containers: [...model.containers, container] };
}

/** Sets a container's semantic role (e.g. "namespace", "system-boundary", "box" — see
 *  DiagramContainer.role's own doc comment for the full per-family vocabulary). Mirrors
 *  updateNodeRole's exact shape. No-op for an unknown id. */
export function setContainerRole(model: DiagramModel, containerId: string, role: string): DiagramModel {
  if (!model.containers.some((c) => c.id === containerId)) return model;
  return {
    ...model,
    containers: model.containers.map((c) => (c.id === containerId ? { ...c, role } : c)),
  };
}

/** canvas-2s6.7: sets a flowchart subgraph's own `direction` override (DiagramContainer.direction
 *  — flowchart only), or clears it back to unset (inheriting the diagram's top-level direction)
 *  when passed `undefined`. Had no op at all before this bead — DSL/import round-trip already
 *  worked (jmuir-dzd grouping E), but nothing could set or clear it interactively. No-op for an
 *  unknown id. */
export function setContainerDirection(
  model: DiagramModel,
  containerId: string,
  direction: FlowchartDirection | undefined,
): DiagramModel {
  if (!model.containers.some((c) => c.id === containerId)) return model;
  return {
    ...model,
    containers: model.containers.map((c) => {
      if (c.id !== containerId) return c;
      if (direction === undefined) {
        const { direction: _removed, ...rest } = c;
        return rest;
      }
      return { ...c, direction };
    }),
  };
}

/** Nests a container inside another (C4/UML nesting) — mirrors assignNodeToContainer's exact
 *  shape. No-op if either id is missing, if a container would be nested inside itself, or (canvas-
 *  2s6.8) inside any of its own DESCENDANTS — walks parentContainerId's own ancestor chain and
 *  rejects if containerId appears anywhere in it, so e.g. nesting A (which already contains B,
 *  which already contains C) into C can't silently create a cycle no renderer/serializer could
 *  ever terminate on. */
export function setContainerParent(
  model: DiagramModel,
  containerId: string,
  parentContainerId: string,
): DiagramModel {
  if (containerId === parentContainerId) return model;
  if (!model.containers.some((c) => c.id === containerId)) return model;
  if (!model.containers.some((c) => c.id === parentContainerId)) return model;
  let ancestor: string | undefined = parentContainerId;
  const seen = new Set<string>();
  while (ancestor !== undefined) {
    if (ancestor === containerId) return model;
    // Already-corrupt data (a pre-existing cycle from some other source) breaks defensively
    // rather than looping forever, instead of also rejecting this otherwise-unrelated call.
    if (seen.has(ancestor)) break;
    seen.add(ancestor);
    ancestor = model.containers.find((c) => c.id === ancestor)?.parentContainerId;
  }
  return {
    ...model,
    containers: model.containers.map((c) => (c.id === containerId ? { ...c, parentContainerId } : c)),
  };
}

/** Un-nests a container back to top-level — mirrors removeNodeFromContainer's exact shape. No-op
 *  for an unknown id. */
export function removeContainerParent(model: DiagramModel, containerId: string): DiagramModel {
  if (!model.containers.some((c) => c.id === containerId)) return model;
  return {
    ...model,
    containers: model.containers.map((c) => {
      if (c.id !== containerId) return c;
      const { parentContainerId: _removed, ...rest } = c;
      return rest;
    }),
  };
}

/** Sequence diagrams only: nests a message inside a control-flow block/branch container — mirrors
 *  assignNodeToContainer's exact shape, for DiagramEdge.containerId instead of
 *  DiagramNode.containerId. No-op for an unknown edge or container id. */
export function assignEdgeToContainer(model: DiagramModel, edgeId: string, containerId: string): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  if (!model.containers.some((c) => c.id === containerId)) return model;
  return {
    ...model,
    edges: model.edges.map((e) => (e.id === edgeId ? { ...e, containerId } : e)),
  };
}

/** Removes a message from whatever control-flow block it is in — mirrors
 *  removeNodeFromContainer's exact shape. No-op for an unknown id. */
export function removeEdgeFromContainer(model: DiagramModel, edgeId: string): DiagramModel {
  if (!model.edges.some((e) => e.id === edgeId)) return model;
  return {
    ...model,
    edges: model.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const { containerId: _removed, ...rest } = e;
      return rest;
    }),
  };
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
 *
 * canvas-2s6.1: also releases member EDGES (a sequence block's own messages, via
 * `DiagramEdge.containerId`) the same way — this membership concept didn't exist before this
 * bead, so nothing previously exercised it, but leaving it out now would be exactly the "dangling
 * reference" FR-013 already guards against for nodes.
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
    edges: model.edges.map((e) => {
      if (e.containerId !== containerId) return e;
      const { containerId: _released, ...rest } = e;
      return rest;
    }),
  };
}

export interface SequenceAutonumberPatch {
  /** false clears `sequenceAutonumber` back to unset (an `autonumber off`-equivalent, matching
   *  dsl/sequence.ts's own "absent means never turned on" parse convention — a lone `autonumber
   *  off` with nothing preceding it is already a no-op there too). true sets it, using `start`/
   *  `step` when both are given or the bare form when either is omitted (mirrors serializeSequence's
   *  own `start !== undefined && step !== undefined` branch exactly). */
  enabled: boolean;
  start?: number;
  step?: number;
}

/** Sets or clears a sequence diagram's `autonumber` directive — a model-level (not per-element)
 *  field, so unlike every other op in this file there's no id parameter, just the whole model.
 *  No other field is touched. */
export function setSequenceAutonumber(model: DiagramModel, patch: SequenceAutonumberPatch): DiagramModel {
  if (!patch.enabled) {
    if (model.sequenceAutonumber === undefined) return model;
    const { sequenceAutonumber: _removed, ...rest } = model;
    return rest;
  }
  return { ...model, sequenceAutonumber: { start: patch.start, step: patch.step } };
}
