import { describe, expect, it } from 'vitest';
import type { DiagramModel } from '@canvas/diagram-core';
import { createDiagramTools } from '../../src/ai/diagram-tools.js';
import { buildStandardPrompt } from '../../src/ai/standard-prompt.js';
import { C4_CONTEXT_STANDARD, VALUE_CHAIN_STANDARD } from '../../src/seed/reference-standards.seed.js';
import { collectToolEnumValues } from '../helpers/zod-enums.js';

/**
 * canvas-tfr drift guard: every value a standard-driven tool enum can take (element kind ids and
 * approved swatch colors) must appear verbatim in the standard prompt, so the prompt can't go
 * stale relative to the tool schemas.
 */
const CASES = [
  ['flowchart', 'VALUE_CHAIN_STANDARD', VALUE_CHAIN_STANDARD],
  ['c4', 'C4_CONTEXT_STANDARD', C4_CONTEXT_STANDARD],
] as const;

describe('standard prompt drift guard', () => {
  it.each(CASES)('every standard-sourced enum value for %s (%s) appears in the prompt', (family, _name, rules) => {
    let model: DiagramModel = { diagramTypeId: family, nodes: [], edges: [], containers: [] };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, family, rules);
    const enumValues = collectToolEnumValues(tools);

    const baseline = new Set<string>();
    const noRulesTools = createDiagramTools({ getModel: () => model, setModel: () => {} }, family);
    for (const v of collectToolEnumValues(noRulesTools)) baseline.add(v);

    const kinds = rules.elementKinds!;
    const expected = new Set<string>([
      ...kinds.map((k) => k.id),
      ...kinds.flatMap((k) => [...k.approvedFills, ...(k.approvedStrokes ?? [])]),
    ]);
    // Sanity: the kind ids really are reachable via the tools (instrument not vacuous).
    for (const k of kinds) expect(enumValues.has(k.id)).toBe(true);

    const prompt = buildStandardPrompt(rules, family);
    expect(prompt).toBeDefined();
    const missing = [...expected].filter((v) => !prompt!.includes(v));
    expect(missing).toEqual([]);

    // Any enum value new relative to the no-rules tool set must come from the standard and be in the prompt.
    const standardOnly = [...enumValues].filter((v) => !baseline.has(v));
    expect(standardOnly.filter((v) => !prompt!.includes(v))).toEqual([]);
  });

  it('returns undefined for an empty v1-only standard', () => {
    const empty = { allowedShapeIds: [], mandatoryShapeIds: [], allowedIconLibraryRefs: [], colorPalette: [] };
    expect(buildStandardPrompt(empty, 'flowchart')).toBeUndefined();
    expect(buildStandardPrompt(empty, 'c4')).toBeUndefined();
  });

  it('includes the section header, guidance text and the newViolations hint', () => {
    const prompt = buildStandardPrompt(VALUE_CHAIN_STANDARD, 'flowchart')!;
    expect(prompt.startsWith('Standard for this diagram')).toBe(true);
    expect(prompt).toContain('Guidance:');
    expect(prompt).toContain("Porter's value chain");
    expect(prompt).toContain('Only these connections are allowed');
    expect(prompt).toContain('newViolations');
  });

  it('omits element kinds for a family that cannot carry them', () => {
    const prompt = buildStandardPrompt(VALUE_CHAIN_STANDARD, 'erd');
    expect(prompt ?? '').not.toContain('primary_activity ("');
  });
});
