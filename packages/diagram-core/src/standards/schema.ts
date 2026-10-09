import type { DiagramEdge, NodeShape } from '../model/diagram-model.js';

export type EdgeArrow = NonNullable<DiagramEdge['arrow']>;
export type EdgeLineStyle = NonNullable<DiagramEdge['lineStyle']>;

/** canvas-tfr: 'error' renders as "Must fix" but is still informational -- no save is ever
 *  blocked by a standard (the user's "constrain + flag" decision). */
export type Severity = 'error' | 'warning' | 'info';

/**
 * canvas-tfr: a semantic, standard-defined element (e.g. a value chain's "Primary Activity", a C4
 * Context "External System"). Carried on the model as `DiagramNode.role` -- for flowchart that is
 * the node's Mermaid class (`A[x]:::primary_activity`), for C4 it is the existing macro-derived
 * role (optionally narrowed by `match.external`). One definition drives the draw toolbar, the AI
 * tool enums, and live validation of hand-written DSL alike.
 */
export interface ElementKind {
  /** `^[a-z][a-z0-9_]*$` -- must be a valid flowchart ID token (no `-`), and not a reserved word. */
  id: string;
  label: string;
  /** Shown to the AI and as a tooltip. */
  description?: string;
  /** Allowed shapes; the first is the default for new elements. Empty = any shape valid for the family. */
  shapes: NodeShape[];
  /** Approved fill hex colors; the first is the default. Empty = unconstrained. */
  approvedFills: string[];
  approvedStrokes?: string[];
  /** C4 only: which role (+ optional external flag) this kind classifies. Defaults to `{ role: id }`. */
  match?: { role: string; external?: boolean };
  minCount?: number;
  maxCount?: number;
  /** Flag elements of this kind that have no connector at all. */
  requireConnection?: boolean;
}

/** canvas-tfr: a permitted connection between two element kinds (`'*'` = any kind). Edges carry no
 *  persisted kind in v1 -- a rule applies to an edge by its endpoints' kinds. */
export interface ConnectorRule {
  id: string;
  label: string;
  from: string;
  to: string;
  /** Allowed line styles; the first is the default. Empty/absent = unconstrained. */
  lineStyles?: EdgeLineStyle[];
  /** Allowed arrowhead placements; the first is the default. Empty/absent = unconstrained. */
  arrows?: EdgeArrow[];
  approvedStrokes?: string[];
  requireLabel?: boolean;
  /** Max edges matching this rule leaving any single source element. */
  maxPerSource?: number;
}

export interface ContainerRules {
  allowed: boolean;
  /** If set, only containers with one of these roles are allowed (C4 boundary roles etc.). */
  allowedRoles?: string[];
}

export const RULE_IDS = [
  'allowed-shapes',
  'mandatory-shapes',
  'allowed-icon-libraries',
  'color-palette',
  'font-family',
  'font-size',
  'unknown-kind',
  'kind-shape',
  'kind-fill',
  'kind-stroke',
  'kind-min-count',
  'kind-max-count',
  'kind-unconnected',
  'connector-not-allowed',
  'connector-style',
  'connector-label-required',
  'connector-max-per-source',
  'container-not-allowed',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const DEFAULT_SEVERITY: Record<RuleId, Severity> = {
  'allowed-shapes': 'warning',
  'mandatory-shapes': 'warning',
  'allowed-icon-libraries': 'warning',
  'color-palette': 'warning',
  'font-family': 'warning',
  'font-size': 'warning',
  'unknown-kind': 'error',
  'kind-shape': 'warning',
  'kind-fill': 'warning',
  'kind-stroke': 'info',
  'kind-min-count': 'error',
  'kind-max-count': 'error',
  'kind-unconnected': 'info',
  'connector-not-allowed': 'error',
  'connector-style': 'info',
  'connector-label-required': 'warning',
  'connector-max-per-source': 'warning',
  'container-not-allowed': 'warning',
};

/** Words that can't be a kind id: Mermaid flowchart keywords, and `default` (which `classDef
 *  default` would apply to every node). */
export const RESERVED_KIND_IDS = ['default', 'end', 'class', 'classdef', 'style', 'subgraph', 'click', 'linkstyle', 'graph', 'flowchart', 'direction'] as const;
export const KIND_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface IconLibraryRef {
  libraryId: string;
  libraryVersion: string;
}

export interface ColorPaletteEntry {
  /** Semantic role this color applies to, e.g. "person", "system", "container" (DiagramNode.role). */
  role: string;
  colorHex: string;
}

export interface FontConstraints {
  family?: string;
  minSize?: number;
  maxSize?: number;
}

/**
 * An admin-defined, versioned rule set bound to one DiagramType (data-model.md's Standard
 * entity). Structured and machine-evaluable — Constitution II: "machine-checked, not advisory."
 */
export interface StandardRules {
  /** If non-empty, every node's shape must be one of these. */
  allowedShapeIds: NodeShape[];
  /** Shapes that MUST appear at least once somewhere in a compliant diagram of this type. */
  mandatoryShapeIds: NodeShape[];
  /** If non-empty, every node icon reference must match one of these (libraryId + version). */
  allowedIconLibraryRefs: IconLibraryRef[];
  /** Required color per semantic node role. */
  colorPalette: ColorPaletteEntry[];
  fontConstraints?: FontConstraints;
  // ---- canvas-tfr (v2), all optional so v1 standards stay valid unchanged ----
  elementKinds?: ElementKind[];
  connectorRules?: ConnectorRule[];
  /** 'listed-only': an edge whose endpoint kinds match no rule is a violation. Default 'any'. */
  connectorPolicy?: 'listed-only' | 'any';
  containers?: ContainerRules;
  /** Every node must classify as one of `elementKinds`. */
  requireKnownKinds?: boolean;
  severityOverrides?: Partial<Record<RuleId, Severity>>;
  /** Free-text guidance for authors and the AI (e.g. "support activities sit above primaries"). */
  guidance?: string;
}

export function emptyStandardRules(): StandardRules {
  return {
    allowedShapeIds: [],
    mandatoryShapeIds: [],
    allowedIconLibraryRefs: [],
    colorPalette: [],
  };
}
