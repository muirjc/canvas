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
}

export interface DiagramEdge {
  id: ElementId;
  sourceId: ElementId;
  targetId: ElementId;
  label?: string;
  style?: NodeStyle;
  /** Which endpoint(s) carry an arrowhead. Architecture diagrams use 'source'/'target' for
   *  directional anchors; flowchart additionally uses 'both' for a bidirectional edge (`<-->`). */
  arrow?: 'none' | 'source' | 'target' | 'both';
  /** Flowchart only: the connector's line rendering — undefined means 'solid' (the default,
   *  ordinary `-->`). 'invisible' is Mermaid's `~~~`, used purely as a layout hint. */
  lineStyle?: 'solid' | 'dotted' | 'thick' | 'invisible';
  /** Architecture diagrams only: the `:T`/`:B`/`:L`/`:R` anchor hint at each endpoint, if any. */
  sourceAnchor?: 'T' | 'B' | 'L' | 'R';
  targetAnchor?: 'T' | 'B' | 'L' | 'R';
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
   * or 'break'. */
  role?: string;
  /** Sequence notes only (role starts with 'note-'): the participant id(s) the note is attached
   * to — one for 'note-left'/'note-right', one or more for 'note-over'. */
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
  /** Flowchart-only: the parsed direction, preserved for round-trip serialization. */
  direction?: FlowchartDirection;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  containers: DiagramContainer[];
}

export function createEmptyDiagramModel(diagramTypeId: string): DiagramModel {
  return { diagramTypeId, nodes: [], edges: [], containers: [] };
}
