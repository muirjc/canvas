import type { DiagramModel, DiagramNode, NodeShape, NodeStyle } from '../model/diagram-model.js';
import type { ConnectorRule, EdgeArrow, EdgeLineStyle, ElementKind, StandardRules } from './schema.js';

/**
 * canvas-tfr: which element kind (if any) a node is. A kind matches when the node's role equals
 * `kind.match?.role ?? kind.id` and, if `kind.match.external` is set, the node's `external` flag
 * (absent = false) equals it. First match in `rules.elementKinds` order wins -- unless the node's
 * tags name a fitting kind (canvas-7hp), which wins outright.
 */
export function classifyNode(node: DiagramNode, rules: StandardRules): ElementKind | undefined {
  if (!node.role) return undefined;
  const kinds = rules.elementKinds ?? [];
  // canvas-7hp: an explicit per-element kind (a C4 `$tags` entry naming a kind) wins, as long as
  // that kind actually fits the node -- this is how several kinds can share one C4 role. The
  // first fitting tag decides; tags that aren't kind ids are ignored.
  for (const tag of node.tags ?? []) {
    const tagged = kinds.find((kind) => kind.id === tag && kindFitsNode(kind, node));
    if (tagged) return tagged;
  }
  return kinds.find((kind) => kindFitsNode(kind, node));
}

/** Whether a node's role (+ external flag) satisfies a kind's match, ignoring tags. */
function kindFitsNode(kind: ElementKind, node: Pick<DiagramNode, 'role' | 'external'>): boolean {
  const role = kind.match?.role ?? kind.id;
  if (role !== node.role) return false;
  const wantExternal = kind.match?.external;
  return wantExternal === undefined || wantExternal === Boolean(node.external);
}

/**
 * canvas-7hp: true when another kind in `rules` would also match an element of `kind` by role (+
 * external) alone -- i.e. the element needs an explicit tag to be identified as `kind`. Decided by
 * overlap, not list order, so reordering kinds later can't silently change an untagged element.
 */
export function kindNeedsTag(kind: ElementKind, rules: StandardRules): boolean {
  if (!kind.match) return false;
  const sample = { role: kind.match.role, external: kind.match.external };
  return (rules.elementKinds ?? []).some((other) => {
    if (other.id === kind.id) return false;
    if (kindFitsNode(other, { role: sample.role, external: sample.external ?? false })) return true;
    // A kind with external unset matches both; overlapping in either direction is ambiguous.
    return sample.external === undefined && kindFitsNode(other, { role: sample.role, external: true });
  });
}

/**
 * canvas-7hp: the node's tags after it becomes `kind`: every tag naming one of the standard's kinds
 * is dropped, unrelated tags are kept in order, and `kind.id` leads the list when the kind needs a
 * tag (kindNeedsTag). Undefined when nothing is left.
 */
export function tagsForKind(node: Pick<DiagramNode, 'tags'>, kind: ElementKind, rules: StandardRules): string[] | undefined {
  const kindIds = new Set((rules.elementKinds ?? []).map((k) => k.id));
  const others = (node.tags ?? []).filter((tag) => !kindIds.has(tag));
  const next = kindNeedsTag(kind, rules) ? [kind.id, ...others] : others;
  return next.length > 0 ? next : undefined;
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

/**
 * canvas-8o01: whether a diagram already has as many elements of this kind as its `maxCount`
 * allows, so the editor and the AI refuse to add another (typed DSL can still exceed it; the
 * validator's kind-max-count flags that). `ignoreNodeId` leaves one element out of the count --
 * the element being changed to this kind, which mustn't count against itself.
 */
export function kindLimitReached(model: DiagramModel, rules: StandardRules, kind: ElementKind, ignoreNodeId?: string): boolean {
  if (kind.maxCount === undefined) return false;
  const count = model.nodes.filter((node) => node.id !== ignoreNodeId && classifyNode(node, rules)?.id === kind.id).length;
  return count >= kind.maxCount;
}

/** canvas-8o01: the explanation shown (and given to the AI) when a kind is at its limit. */
export function kindLimitMessage(kind: ElementKind): string {
  const max = kind.maxCount ?? 0;
  return max === 1 ? `This diagram already has its 1 ${kind.label}.` : `This diagram already has its ${max} ${kind.label} elements, the most allowed.`;
}
