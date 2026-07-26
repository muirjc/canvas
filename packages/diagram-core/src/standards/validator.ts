import type { DiagramModel } from '../model/diagram-model.js';
import type { StandardRules } from './schema.js';

export interface Violation {
  elementId: string;
  rule: string;
  message: string;
  severity: 'warning';
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

/**
 * Validates a DiagramModel against a Standard's rules. Pure function — no I/O, no hidden state —
 * so it produces the same result whether called from the browser (live feedback) or the server
 * (save-time re-check), per contracts/diagram-core-contract.md.
 */
export function validate(model: DiagramModel, rules: StandardRules): Violation[] {
  const violations: Violation[] = [];
  checkAllowedShapes(model, rules, violations);
  checkMandatoryShapes(model, rules, violations);
  checkIconLibraries(model, rules, violations);
  checkColorPalette(model, rules, violations);
  checkFontConstraints(model, rules, violations);
  return violations;
}
