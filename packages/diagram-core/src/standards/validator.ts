import type { DiagramModel } from '../model/diagram-model.js';
import { resolveNodeFillStroke } from '../render/svg-renderer.js';
import { classifyNode, isApprovedColor, resolveConnectorRule } from './kinds.js';
import { DEFAULT_SEVERITY, type ElementKind, type RuleId, type Severity, type StandardRules } from './schema.js';

export interface Violation {
  elementId: string;
  rule: string;
  message: string;
  /** v1 rules only ever produced 'warning'; canvas-tfr widened this (cached v1 results stay valid). */
  severity: Severity;
  /** canvas-tfr: what `elementId` refers to ('diagram' for whole-diagram rules like min counts). */
  elementType?: 'node' | 'edge' | 'container' | 'diagram';
  /** canvas-tfr: the element kind involved, when there is one. */
  kindId?: string;
}

function checkAllowedShapes(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  if (rules.allowedShapeIds.length === 0) return;
  for (const node of model.nodes) {
    if (!rules.allowedShapeIds.includes(node.shape)) {
      violations.push({
        elementId: node.id,
        rule: 'allowed-shapes',
        message: `Shape "${node.shape}" is not in the approved shape list for this diagram type (${rules.allowedShapeIds.join(', ')}).`,
        severity: 'warning',
      });
    }
  }
}

function checkMandatoryShapes(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  for (const requiredShape of rules.mandatoryShapeIds) {
    const present = model.nodes.some((node) => node.shape === requiredShape);
    if (!present) {
      violations.push({
        elementId: '(diagram)',
        rule: 'mandatory-shapes',
        message: `This diagram type requires at least one "${requiredShape}" shape, but none was found.`,
        severity: 'warning',
      });
    }
  }
}

function checkIconLibraries(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  if (rules.allowedIconLibraryRefs.length === 0) return;
  for (const node of model.nodes) {
    if (!node.icon) continue;
    const allowed = rules.allowedIconLibraryRefs.some(
      (ref) => ref.libraryId === node.icon!.libraryId && ref.libraryVersion === node.icon!.libraryVersion,
    );
    if (!allowed) {
      violations.push({
        elementId: node.id,
        rule: 'allowed-icon-libraries',
        message: `Icon from "${node.icon.libraryId}@${node.icon.libraryVersion}" is not an approved icon library/version for this diagram type.`,
        severity: 'warning',
      });
    }
  }
}

function checkColorPalette(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  if (rules.colorPalette.length === 0) return;
  const requiredColorByRole = new Map(rules.colorPalette.map((entry) => [entry.role, entry.colorHex]));
  for (const node of model.nodes) {
    if (!node.role) continue;
    const requiredColor = requiredColorByRole.get(node.role);
    if (!requiredColor) continue;
    const actualColor = node.style?.fillColor;
    if (actualColor && actualColor.toLowerCase() !== requiredColor.toLowerCase()) {
      violations.push({
        elementId: node.id,
        rule: 'color-palette',
        message: `Nodes with role "${node.role}" must use color ${requiredColor}, but this node uses ${actualColor}.`,
        severity: 'warning',
      });
    }
  }
}

function checkFontConstraints(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  const constraints = rules.fontConstraints;
  if (!constraints) return;
  for (const node of model.nodes) {
    const style = node.style;
    if (!style) continue;
    if (constraints.family && style.fontFamily && style.fontFamily !== constraints.family) {
      violations.push({
        elementId: node.id,
        rule: 'font-family',
        message: `Font "${style.fontFamily}" is not the approved font "${constraints.family}" for this diagram type.`,
        severity: 'warning',
      });
    }
    if (style.fontSize !== undefined) {
      if (constraints.minSize !== undefined && style.fontSize < constraints.minSize) {
        violations.push({
          elementId: node.id,
          rule: 'font-size',
          message: `Font size ${style.fontSize} is below the minimum approved size ${constraints.minSize}.`,
          severity: 'warning',
        });
      }
      if (constraints.maxSize !== undefined && style.fontSize > constraints.maxSize) {
        violations.push({
          elementId: node.id,
          rule: 'font-size',
          message: `Font size ${style.fontSize} exceeds the maximum approved size ${constraints.maxSize}.`,
          severity: 'warning',
        });
      }
    }
  }
}

// ---- canvas-tfr: v2 checks (element kinds, connectors, containers) ----

function checkKinds(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  const kinds = rules.elementKinds ?? [];
  if (kinds.length === 0) return;
  const counts = new Map<string, number>();
  const connected = new Set<string>();
  for (const edge of model.edges) {
    connected.add(edge.sourceId);
    connected.add(edge.targetId);
  }

  for (const node of model.nodes) {
    const kind = classifyNode(node, rules);
    if (!kind) {
      if (rules.requireKnownKinds) {
        violations.push({
          elementId: node.id,
          elementType: 'node',
          rule: 'unknown-kind',
          message: node.role
            ? `"${node.label}" is a "${node.role}", which isn't one of this standard's element kinds (${kinds.map((k) => k.label).join(', ')}).`
            : `"${node.label}" has no element kind; this standard expects one of: ${kinds.map((k) => k.label).join(', ')}.`,
          severity: 'warning',
        });
      }
      continue;
    }
    counts.set(kind.id, (counts.get(kind.id) ?? 0) + 1);

    if (kind.shapes.length > 0 && !kind.shapes.includes(node.shape)) {
      violations.push({
        elementId: node.id,
        elementType: 'node',
        kindId: kind.id,
        rule: 'kind-shape',
        message: `${kind.label} "${node.label}" uses shape "${node.shape}"; allowed: ${kind.shapes.join(', ')}.`,
        severity: 'warning',
      });
    }
    // The fill/stroke actually drawn, so what you see is what is checked: an unstyled flowchart
    // node renders white, an unstyled C4 element renders its role's default color.
    const { fill, stroke } = resolveNodeFillStroke(node, model.diagramTypeId);
    if (kind.approvedFills.length > 0 && !isApprovedColor(fill, kind.approvedFills)) {
      violations.push({
        elementId: node.id,
        elementType: 'node',
        kindId: kind.id,
        rule: 'kind-fill',
        message: `${kind.label} "${node.label}" is filled ${fill}; approved: ${kind.approvedFills.join(', ')}.`,
        severity: 'warning',
      });
    }
    if (kind.approvedStrokes && kind.approvedStrokes.length > 0 && !isApprovedColor(stroke, kind.approvedStrokes)) {
      violations.push({
        elementId: node.id,
        elementType: 'node',
        kindId: kind.id,
        rule: 'kind-stroke',
        message: `${kind.label} "${node.label}" has border ${stroke}; approved: ${kind.approvedStrokes.join(', ')}.`,
        severity: 'warning',
      });
    }
    if (kind.requireConnection && !connected.has(node.id)) {
      violations.push({
        elementId: node.id,
        elementType: 'node',
        kindId: kind.id,
        rule: 'kind-unconnected',
        message: `${kind.label} "${node.label}" isn't connected to anything.`,
        severity: 'warning',
      });
    }
  }

  for (const kind of kinds) {
    const count = counts.get(kind.id) ?? 0;
    if (kind.minCount !== undefined && count < kind.minCount) {
      violations.push({
        elementId: '(diagram)',
        elementType: 'diagram',
        kindId: kind.id,
        rule: 'kind-min-count',
        message: `Needs at least ${kind.minCount} ${kind.label}${kind.minCount === 1 ? '' : ' elements'}; found ${count}.`,
        severity: 'warning',
      });
    }
    if (kind.maxCount !== undefined && count > kind.maxCount) {
      violations.push({
        elementId: '(diagram)',
        elementType: 'diagram',
        kindId: kind.id,
        rule: 'kind-max-count',
        message: `Allows at most ${kind.maxCount} ${kind.label}${kind.maxCount === 1 ? '' : ' elements'}; found ${count}.`,
        severity: 'warning',
      });
    }
  }
}

function checkConnectors(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  const hasRules = (rules.connectorRules ?? []).length > 0;
  if (!hasRules && rules.connectorPolicy !== 'listed-only') return;
  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));
  const kindOf = (id: string): ElementKind | undefined => {
    const node = nodesById.get(id);
    return node ? classifyNode(node, rules) : undefined;
  };
  const perSourceRule = new Map<string, number>();

  for (const edge of model.edges) {
    const from = kindOf(edge.sourceId);
    const to = kindOf(edge.targetId);
    const rule = resolveConnectorRule(rules, from?.id, to?.id);
    const fromLabel = from?.label ?? 'unclassified element';
    const toLabel = to?.label ?? 'unclassified element';
    if (!rule) {
      if (rules.connectorPolicy === 'listed-only') {
        violations.push({
          elementId: edge.id,
          elementType: 'edge',
          rule: 'connector-not-allowed',
          message: `This standard doesn't allow a connection from ${fromLabel} to ${toLabel}.`,
          severity: 'warning',
        });
      }
      continue;
    }
    // Defaults mirror how an unstyled edge is drawn: a solid line with a target arrowhead.
    const lineStyle = edge.lineStyle ?? 'solid';
    const arrow = edge.arrow ?? 'target';
    const badLine = rule.lineStyles && rule.lineStyles.length > 0 && !rule.lineStyles.includes(lineStyle);
    const badArrow = rule.arrows && rule.arrows.length > 0 && !rule.arrows.includes(arrow);
    const stroke = edge.style?.strokeColor;
    const badStroke = stroke !== undefined && rule.approvedStrokes && rule.approvedStrokes.length > 0 && !isApprovedColor(stroke, rule.approvedStrokes);
    if (badLine || badArrow || badStroke) {
      const parts: string[] = [];
      if (badLine) parts.push(`line "${lineStyle}" (allowed: ${rule.lineStyles!.join(', ')})`);
      if (badArrow) parts.push(`arrowhead "${arrow}" (allowed: ${rule.arrows!.join(', ')})`);
      if (badStroke) parts.push(`color ${stroke} (approved: ${rule.approvedStrokes!.join(', ')})`);
      violations.push({
        elementId: edge.id,
        elementType: 'edge',
        rule: 'connector-style',
        message: `${rule.label} connector uses ${parts.join(', ')}.`,
        severity: 'warning',
      });
    }
    if (rule.requireLabel && !edge.label?.trim()) {
      violations.push({
        elementId: edge.id,
        elementType: 'edge',
        rule: 'connector-label-required',
        message: `${rule.label} connections from ${fromLabel} to ${toLabel} need a label.`,
        severity: 'warning',
      });
    }
    if (rule.maxPerSource !== undefined) {
      const key = `${edge.sourceId}\u0000${rule.id}`;
      const seen = (perSourceRule.get(key) ?? 0) + 1;
      perSourceRule.set(key, seen);
      if (seen > rule.maxPerSource) {
        violations.push({
          elementId: edge.id,
          elementType: 'edge',
          rule: 'connector-max-per-source',
          message: `A ${fromLabel} may have at most ${rule.maxPerSource} ${rule.label} connection${rule.maxPerSource === 1 ? '' : 's'}.`,
          severity: 'warning',
        });
      }
    }
  }
}

function checkContainers(model: DiagramModel, rules: StandardRules, violations: Violation[]): void {
  const policy = rules.containers;
  if (!policy) return;
  for (const container of model.containers) {
    const notAllowed = !policy.allowed;
    const badRole = policy.allowed && policy.allowedRoles !== undefined && !policy.allowedRoles.includes(container.role ?? '');
    if (notAllowed || badRole) {
      violations.push({
        elementId: container.id,
        elementType: 'container',
        rule: 'container-not-allowed',
        message: notAllowed
          ? `This standard doesn't use groupings, but "${container.label}" is one.`
          : `"${container.label}" is a ${container.role ?? 'plain'} grouping; allowed: ${policy.allowedRoles!.join(', ')}.`,
        severity: 'warning',
      });
    }
  }
}

/**
 * Validates a DiagramModel against a Standard's rules. Pure function — no I/O, no hidden state —
 * so it produces the same result whether called from the browser (live feedback) or the server
 * (save-time re-check), per contracts/diagram-core-contract.md.
 *
 * canvas-tfr: severities come from DEFAULT_SEVERITY (v1 rules stay 'warning') overridden by
 * `rules.severityOverrides`; none of them ever blocks a save.
 */
export function validate(model: DiagramModel, rules: StandardRules): Violation[] {
  const violations: Violation[] = [];
  checkAllowedShapes(model, rules, violations);
  checkMandatoryShapes(model, rules, violations);
  checkIconLibraries(model, rules, violations);
  checkColorPalette(model, rules, violations);
  checkFontConstraints(model, rules, violations);
  checkKinds(model, rules, violations);
  checkConnectors(model, rules, violations);
  checkContainers(model, rules, violations);
  for (const v of violations) {
    const rule = v.rule as RuleId;
    v.severity = rules.severityOverrides?.[rule] ?? DEFAULT_SEVERITY[rule] ?? v.severity;
  }
  return violations;
}
