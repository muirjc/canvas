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
}

export type NodeShape =
  | 'rectangle'
  | 'rounded-rectangle'
  | 'circle'
  | 'diamond'
  | 'cylinder'
  | 'person'
  | 'icon';

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
}

export interface DiagramEdge {
  id: ElementId;
  sourceId: ElementId;
  targetId: ElementId;
  label?: string;
  style?: NodeStyle;
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
