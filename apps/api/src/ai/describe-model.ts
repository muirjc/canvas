import { validate, type DiagramModel, type StandardRules } from '@canvas/diagram-core';

// canvas-1bty.12: its own module so the diagram-core bridge (packages/diagram-bridge) serves the same
// summary to the Python service's chat.

/** A short textual summary of the current diagram, given to the model each turn so it can
 * reference existing shapes/connectors by id (e.g. to remove or rename one). canvas-tfr: under a
 * standard it also shows each element's kind and the violations the diagram currently has. */
export function describeModel(model: DiagramModel, rules?: StandardRules): string {
  const nodes =
    model.nodes
      .map(
        (n) =>
          `- ${n.id}: "${n.label}" (${n.shape}${rules && n.role ? `, kind: ${n.role}${n.external ? ' external' : ''}` : ''})`,
      )
      .join('\n') || '(none yet)';
  const edges =
    model.edges
      .map((e) => `- ${e.id}: ${e.sourceId} -> ${e.targetId}${e.label ? ` ("${e.label}")` : ''}`)
      .join('\n') || '(none yet)';
  let summary = `Current shapes:\n${nodes}\n\nCurrent connectors:\n${edges}`;
  if (rules) {
    const violations = validate(model, rules).slice(0, 10);
    if (violations.length > 0) {
      summary += `\n\nCurrent standard violations:\n${violations.map((v) => `- [${v.severity}] ${v.elementId}: ${v.message}`).join('\n')}`;
    }
  }
  return summary;
}
