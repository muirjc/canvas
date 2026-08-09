/**
 * Core diagram object model shared by every DSL family (flowchart, C4, sequence, ERD, UML,
 * architecture/cloud-infrastructure, and the business-diagram flowchart variants).
 *
 * This is the single in-memory representation the interactive canvas edits and the DSL
 * parser/serializer round-trips against (Constitution Principle I).
 */

export type ElementId = string;

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A reference to an icon in a specific, version-pinned Icon/Shape Library (Constitution V). */
export interface IconRef {
  libraryId: string;
  libraryVersion: string;
  iconId: string;
}

export interface NodeStyle {
  /** Hex color, e.g. "#1168bd" */
  fillColor?: string;
  strokeColor?: string;
  fontFamily?: string;
  fontSize?: number;
  /** Line thickness in px — meaningful for edges (`linkStyle`), rarely used for node borders. */
  strokeWidth?: number;
  /** Raw SVG `stroke-dasharray` value (e.g. "5 5") — dotted/dashed edges via `linkStyle`. */
  strokeDasharray?: string;
}

export type NodeShape =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'circle'
  | 'diamond'
  | 'cylinder'
  | 'person'
  | 'icon'
  // Feature 009: orientation is part of the shape's identity, not a separate field —
  // `parallelogram`/`trapezoid` each have a mirrored `-alt` counterpart (see data-model.md).
  | 'stadium'
  | 'subroutine'
  | 'double-circle'
  | 'hexagon'
  | 'parallelogram'
  | 'parallelogram-alt'
  | 'trapezoid'
  | 'trapezoid-alt'
  | 'asymmetric';

/** An ER entity attribute: a typed field with zero or more key constraints (ERD only). */
export interface EntityAttribute {
  type: string;
  name: string;
  keys: string[];
}

/** jmuir-dtu.2: a single UML class member — either an attribute (`type` set, no `params`) or a
 *  method (`params` set, possibly empty string for `()`). Both share the same visibility/modifier
 *  vocabulary, so one shape covers both rather than two near-duplicate interfaces. */
export interface ClassMember {
  kind: 'attribute' | 'method';
  /** '+' public, '-' private, '#' protected, '~' package/internal; absent if unmarked. */
  visibility?: '+' | '-' | '#' | '~';
  name: string;
  /** Attributes only: the declared type (e.g. "List~string~", generics included verbatim). */
  type?: string;
  /** Methods only: the raw parameter-list text between the parens (possibly empty). */
  params?: string;
  /** Methods only: the return type, if any (e.g. "List~string~"). */
  returnType?: string;
  /** `$` suffix. */
  isStatic?: boolean;
  /** `*` suffix. */
  isAbstract?: boolean;
}

export interface DiagramNode {
  id: ElementId;
  label: string;
  shape: NodeShape;
  /** Semantic role used by Standards validation, e.g. "person", "system", "container". */
  role?: string;
  position: Position;
  size?: Size;
  style?: NodeStyle;
  icon?: IconRef;
  /** Id of the DiagramContainer this node is nested inside, if any. */
  containerId?: ElementId;
  /** ERD only: this entity's declared attributes, in declaration order. */
  attributes?: EntityAttribute[];
  /** jmuir-dtu.2: UML only — this class's declared members (attributes and methods), in
   *  declaration order, from its `class Foo { ... }` body. */
  members?: ClassMember[];
  /** jmuir-dtu.2: UML only — a `<<Stereotype>>` annotation (e.g. "Interface", "Abstract",
   *  "Service", "Enumeration", or any custom word — Mermaid doesn't restrict this to a fixed
   *  set). Distinct from `role` (always 'class' for every UML node — the `class` keyword itself
   *  never changes regardless of stereotype); this is a supplementary tag, not the node's
   *  primary kind. */
  umlStereotype?: string;
}

export interface DiagramEdge {
  id: ElementId;
  sourceId: ElementId;
  targetId: ElementId;
  label?: string;
  style?: NodeStyle;
  /** Which endpoint(s) carry an arrowhead. Architecture diagrams use 'source'/'target' for
   *  directional anchors; flowchart additionally uses 'both' for a bidirectional edge (`<-->`).
   *  jmuir-dtu.4: sequence diagrams also use 'both' (`<<->>`/`<<-->>`), plus two sequence-only
   *  values: 'cross' (`-x`/`--x`, a failed/erroring message) and 'open' (`-)`/`--)`, an
   *  asynchronous message with an unfilled arrowhead). */
  arrow?: 'none' | 'source' | 'target' | 'both' | 'cross' | 'open';
  /** Flowchart only: the connector's line rendering — undefined means 'solid' (the default,
   *  ordinary `-->`). 'invisible' is Mermaid's `~~~`, used purely as a layout hint.
   *  jmuir-dtu.4: sequence diagrams reuse 'solid'/'dotted' for their own solid-vs-dashed arrow
   *  tokens (e.g. `->>` vs `-->>`) — 'thick'/'invisible' don't apply there. */
  lineStyle?: 'solid' | 'dotted' | 'thick' | 'invisible';
  /** Architecture diagrams only: the `:T`/`:B`/`:L`/`:R` anchor hint at each endpoint, if any. */
  sourceAnchor?: 'T' | 'B' | 'L' | 'R';
  targetAnchor?: 'T' | 'B' | 'L' | 'R';
  /** jmuir-dtu.5: architecture diagrams only — the `{group}` edge modifier, escalating this
   *  endpoint's connection point to the service's parent group boundary rather than the service
   *  itself. `sourceId`/`targetId` still reference the SERVICE, never the group directly — real
   *  Mermaid's own grammar forbids a bare group id in an edge line at all ("groupIds cannot be
   *  used for specifying edges and the {group} modifier can only be used for services within a
   *  group"), so this is a purely visual escalation hint, not a change to what the edge connects. */
  sourceIsGroup?: boolean;
  targetIsGroup?: boolean;
  /** jmuir-dtu.2: UML only — the relationship kind, since a class diagram's arrowhead shape
   *  (hollow triangle, filled diamond, ...) carries real semantic meaning `arrow`/`lineStyle`'s
   *  shared, family-agnostic vocabulary doesn't fit (unlike sequence's arrows, which really are
   *  just filled/open/cross/none + solid/dotted). A dedicated field, matching this model's own
   *  precedent of adding a narrowly-scoped field when the shared one doesn't fit (e.g.
   *  `sourceIsGroup` above), rather than overloading `arrow` with meanings only UML uses. */
  /** jmuir-dtu.2.1: adds the two lollipop-interface tokens (`()--`/`--()`) to the set jmuir-dtu.2
   *  already modeled — 'lollipop-source' means the circle sits at `sourceId` (`Foo ()-- Bar`),
   *  'lollipop-target' means it sits at `targetId` (`Foo --() Bar`); confirmed against Mermaid's
   *  own docs ("the interface with the lollipop connects to the class") that the circle always
   *  renders on whichever endpoint is textually adjacent to the `()` token, independent of which
   *  side is source vs target — so two kinds (not a single 'lollipop' plus a separate boolean) is
   *  the natural fit, matching this field's own existing one-kind-per-literal-token precedent. */
  umlRelationKind?: 'inheritance' | 'composition' | 'aggregation' | 'association' | 'link-solid' | 'dependency' | 'realization' | 'link-dashed' | 'lollipop-source' | 'lollipop-target';
  /** jmuir-dtu.2: UML only — the quoted multiplicity/cardinality label at each end of a
   *  relationship (e.g. "1", "0..1", "*", "1..*"), if given. */
  sourceCardinality?: string;
  targetCardinality?: string;
  /** Sequence diagrams only: source-order position, used to interleave with note/block
   * containers (which live in a separate array) on serialization. */
  sequenceOrder?: number;
  /** Sequence diagrams only: id of the control-flow-block/branch DiagramContainer this message
   * is nested inside, if any — mirrors DiagramNode.containerId's meaning. */
  containerId?: ElementId;
}

/** A visual grouping/boundary (e.g., a C4 "System Boundary" or a Mermaid subgraph). */
export interface DiagramContainer {
  id: ElementId;
  label: string;
  position: Position;
  size?: Size;
  style?: NodeStyle;
  /** Id of a parent container, for nested grouping. */
  parentContainerId?: ElementId;
  /** Semantic kind, mirroring DiagramNode.role. Sequence diagrams only: 'note-left',
   * 'note-right', 'note-over', 'loop', 'alt', 'else', 'opt', 'par', 'and', 'critical', 'option',
   * 'break', 'rect' (a `rect <color> ... end` background highlight — the color lives in `style`,
   * not `label`, which stays empty), 'box' (a `box ... end` participant grouping — members
   * reference it via their own `containerId`, not `attachedNodeIds`, and it sits outside the
   * ordered timeline entirely, so `sequenceOrder`/`parentContainerId` are unset for it), or
   * 'activate'/'deactivate' (jmuir-dtu.4: each occurrence — whether from an explicit `activate
   * <id>`/`deactivate <id>` statement or the `+`/`-` message-arrow shorthand — is its own
   * independent point-in-time item via `attachedNodeIds: [participantId]`, not a linked
   * start/end pair; nothing nests "inside" one the way it does inside loop/alt/rect, so stacked
   * activations for the same participant just become multiple same-role items in sequence).
   * jmuir-dtu.2: UML also uses 'namespace' (a `namespace Name { ... }` grouping — member classes
   * reference it via their own `containerId`, mirroring 'box' above, not `attachedNodeIds`) and
   * 'note' (`note "text"` or `note for ClassName "text"` — a standalone or class-attached note,
   * see `attachedNodeIds` below). */
  role?: string;
  /** Sequence notes only (role starts with 'note-'), 'activate'/'deactivate' (a single id), and
   * UML 'note' (jmuir-dtu.2: zero ids for a standalone `note "text"`, one id for `note for
   * ClassName "text"`): the participant/class id(s) this item is attached to — one for
   * 'note-left'/'note-right'/'activate'/'deactivate'/UML's attached-note form, one or more for
   * 'note-over', zero for UML's standalone-note form. */
  attachedNodeIds?: ElementId[];
  /** Sequence diagrams only: source-order position — see DiagramEdge.sequenceOrder. */
  sequenceOrder?: number;
  /** Flowchart subgraphs only: a `direction <TD|LR|TB|RL|BT>` statement inside this subgraph,
   *  overriding the diagram's top-level direction for it. Note this is preserved for round-trip
   *  only — like the top-level `DiagramModel.direction`, it does not yet drive auto-layout. */
  direction?: FlowchartDirection;
}

/** Mermaid flowchart layout direction (top-down, left-right, etc.), part of the DSL's own grammar. */
export type FlowchartDirection = 'TD' | 'LR' | 'TB' | 'RL' | 'BT';

export interface DiagramModel {
  diagramTypeId: string;
  /** Flowchart and ER diagrams (`graph <direction>` / `direction <direction>` respectively): the
   *  parsed top-level direction, preserved for round-trip serialization. Not yet used to drive
   *  auto-layout for either family (see `autoLayout()`'s own flowchart-only scoping). */
  direction?: FlowchartDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  containers: DiagramContainer[];
  /** jmuir-dtu.4: sequence diagrams only — an `autonumber` statement turns on automatic message
   *  numbering, with optional custom start/step values; `autonumber off` turns it back off. Real
   *  Mermaid allows toggling this at multiple points through a diagram to reset numbering
   *  partway through; this app models only the common single-toggle case (last statement seen
   *  wins) — a disclosed simplification, not a silent-drop bug, since a lone `autonumber off`
   *  with nothing preceding it is already a no-op in real Mermaid too. */
  sequenceAutonumber?: { start?: number; step?: number };
  /** jmuir-dtu.5: architecture diagrams only — `align row <id> <id> ...` / `align column <id>
   *  <id> ...` statements, declaring that a set of service/group ids share a row (same y) or
   *  column (same x). Round-trips as a literal DSL body line (real Mermaid grammar, unlike
   *  `direction`'s own front-matter-free flowchart/ER precedent this mirrors) — this app has no
   *  auto-layout for architecture diagrams yet, so it doesn't drive positioning. */
  architectureAlignments?: { axis: 'row' | 'column'; ids: string[] }[];
}

export function createEmptyDiagramModel(diagramTypeId: string): DiagramModel {
  return { diagramTypeId, nodes: [], edges: [], containers: [] };
}
