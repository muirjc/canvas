import { FAMILY_SUPPORTS_ELEMENT_KINDS, type StandardRules } from '@canvas/diagram-core';

/**
 * canvas-tfr: the active standard, rendered as a compact system-prompt section so the model knows
 * the vocabulary it must draw with -- the same element kinds, swatches and connection rules the
 * canvas toolbar offers and the validator checks. Every value a standard-driven tool enum can take
 * (kind ids, approved colors) appears here verbatim; tests/contract/standard-prompt-drift.test.ts
 * keeps it that way.
 */
export function buildStandardPrompt(rules: StandardRules, family: string): string | undefined {
  const kinds = FAMILY_SUPPORTS_ELEMENT_KINDS.has(family) ? (rules.elementKinds ?? []) : [];
  const lines: string[] = [];

  if (kinds.length > 0) {
    lines.push(
      'This diagram follows a published standard. Build it only from these element kinds, using the ' +
        'addElement tool with the kind id (it applies the right shape and color for you):',
    );
    for (const kind of kinds) {
      const parts = [`- ${kind.id} ("${kind.label}")`];
      if (kind.description) parts.push(`: ${kind.description}`);
      const details: string[] = [];
      if (kind.shapes.length > 0) details.push(`shapes ${kind.shapes.join('/')}`);
      if (kind.approvedFills.length > 0) details.push(`fill ${kind.approvedFills.join(' or ')}`);
      if (kind.approvedStrokes && kind.approvedStrokes.length > 0) details.push(`border ${kind.approvedStrokes.join(' or ')}`);
      if (kind.minCount !== undefined && kind.maxCount !== undefined && kind.minCount === kind.maxCount) {
        details.push(`exactly ${kind.minCount}`);
      } else {
        if (kind.minCount !== undefined) details.push(`at least ${kind.minCount}`);
        if (kind.maxCount !== undefined) details.push(`at most ${kind.maxCount}`);
      }
      if (kind.requireConnection) details.push('must be connected');
      if (details.length > 0) parts.push(` [${details.join('; ')}]`);
      lines.push(parts.join(''));
    }
    if (rules.requireKnownKinds) lines.push('Every element must be one of these kinds.');
  }

  const connectors = rules.connectorRules ?? [];
  if (connectors.length > 0 || rules.connectorPolicy === 'listed-only') {
    lines.push(
      rules.connectorPolicy === 'listed-only'
        ? 'Only these connections are allowed:'
        : 'Connections follow these rules:',
    );
    for (const rule of connectors) {
      const from = rule.from === '*' ? 'any element' : rule.from;
      const to = rule.to === '*' ? 'any element' : rule.to;
      const details: string[] = [];
      if (rule.requireLabel) details.push('needs a label');
      if (rule.maxPerSource !== undefined) details.push(`at most ${rule.maxPerSource} per source`);
      if (rule.lineStyles && rule.lineStyles.length > 0) details.push(`line ${rule.lineStyles.join('/')}`);
      if (rule.approvedStrokes && rule.approvedStrokes.length > 0) details.push(`color ${rule.approvedStrokes.join(' or ')}`);
      lines.push(`- ${rule.label}: ${from} -> ${to}${details.length > 0 ? ` [${details.join('; ')}]` : ''}`);
    }
  }

  if (rules.containers) {
    lines.push(
      !rules.containers.allowed
        ? 'Do not create groupings/boundaries.'
        : rules.containers.allowedRoles
          ? `Groupings allowed: ${rules.containers.allowedRoles.join(', ')}.`
          : 'Groupings are allowed.',
    );
  }

  if (rules.guidance?.trim()) lines.push(`Guidance: ${rules.guidance.trim()}`);

  if (lines.length === 0) return undefined;
  lines.push(
    'Tool results may include newViolations: standard rules your change just broke. Fix them before finishing when you can.',
  );
  return `Standard for this diagram:\n${lines.join('\n')}`;
}
