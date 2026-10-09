import type { DiagramNode, NodeShape, NodeStyle } from '../model/diagram-model.js';
import type { ConnectorRule, EdgeArrow, EdgeLineStyle, ElementKind, StandardRules } from './schema.js';

/**
 * canvas-tfr: which element kind (if any) a node is. A kind matches when the node's role equals
 * `kind.match?.role ?? kind.id` and, if `kind.match.external` is set, the node's `external` flag
 * (absent = false) equals it. First match in `rules.elementKinds` order wins.
 */
export function classifyNode(node: DiagramNode, rules: StandardRules): ElementKind | undefined {
  if (!node.role) return undefined;
  return rules.elementKinds?.find((kind) => {
    const role = kind.match?.role ?? kind.id;
    if (role !== node.role) return false;
    const wantExternal = kind.match?.external;
    return wantExternal === undefined || wantExternal === Boolean(node.external);
  });
}

/**
 * canvas-tfr: the connector rule governing an edge between a `fromKind` and `toKind` element
 * (either may be undefined for an unclassified endpoint). An exact kind→kind rule beats a rule
 * with a `'*'` on one side, which beats `'*'`→`'*'`. Undefined when no rule matches.
 */
export function resolveConnectorRule(
  rules: StandardRules,
  fromKind: string | undefined,
  toKind: string | undefined,
): ConnectorRule | undefined {
  let best: ConnectorRule | undefined;
  let bestScore = -1;
  for (const rule of rules.connectorRules ?? []) {
    const fromOk = rule.from === '*' || (fromKind !== undefined && rule.from === fromKind);
    const toOk = rule.to === '*' || (toKind !== undefined && rule.to === toKind);
    if (!fromOk || !toOk) continue;
    // 2 = exact on both sides, 1 = exact on one side, 0 = wildcard on both.
    const score = (rule.from === '*' ? 0 : 1) + (rule.to === '*' ? 0 : 1);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

export interface KindDefaults {
  role: string;
  external?: boolean;
  shape?: NodeShape;
  style?: NodeStyle;
}

/** canvas-tfr: what a newly created element of `kind` gets: its role (+ external), its default
 *  (first) shape, and its default (first) fill/stroke swatch. Keys are omitted, not undefined,
 *  when the kind doesn't constrain them. */
export function kindDefaults(kind: ElementKind): KindDefaults {
  const defaults: KindDefaults = { role: kind.match?.role ?? kind.id };
  if (kind.match?.external !== undefined) defaults.external = kind.match.external;
  if (kind.shapes.length > 0) defaults.shape = kind.shapes[0];
  const style: NodeStyle = {};
  if (kind.approvedFills.length > 0) style.fillColor = kind.approvedFills[0];
  if (kind.approvedStrokes && kind.approvedStrokes.length > 0) style.strokeColor = kind.approvedStrokes[0];
  if (Object.keys(style).length > 0) defaults.style = style;
  return defaults;
}

export interface ConnectorDefaults {
  arrow?: EdgeArrow;
  lineStyle?: EdgeLineStyle;
  strokeColor?: string;
}

/** canvas-tfr: the first listed line style / arrow / stroke of a connector rule. */
export function connectorDefaults(rule: ConnectorRule): ConnectorDefaults {
  const defaults: ConnectorDefaults = {};
  if (rule.arrows && rule.arrows.length > 0) defaults.arrow = rule.arrows[0];
  if (rule.lineStyles && rule.lineStyles.length > 0) defaults.lineStyle = rule.lineStyles[0];
  if (rule.approvedStrokes && rule.approvedStrokes.length > 0) defaults.strokeColor = rule.approvedStrokes[0];
  return defaults;
}

/** canvas-tfr: case-insensitive membership test for hex swatch lists. */
export function isApprovedColor(color: string, approved: readonly string[]): boolean {
  const lower = color.toLowerCase();
  return approved.some((c) => c.toLowerCase() === lower);
}
