import { describe, expect, it } from 'vitest';
import type { DiagramModel } from '@canvas/diagram-core';
import { createDiagramTools } from '../../src/ai/diagram-tools.js';
import { getDiagramTypePrimer } from '../../src/ai/diagram-type-primers.js';
import { collectEnumValues } from '../helpers/zod-enums.js';

/**
 * 010-ai-diagram-knowledge, T023 (User Story 3, research.md §6): a drift guard for FR-005 — every
 * enum value currently exposed by a family's own tool set must be mentioned somewhere in that
 * family's primer text, so a future grammar expansion that adds a new enum value to a tool schema
 * (the same way jmuir-dtu's own sub-beads have repeatedly done) fails this test instead of quietly
 * leaving the primer's prose stale. Deliberately reads each tool's own live Zod schema at test
 * time — walking `inputSchema`'s real `def` tree for every `ZodEnum` reachable through it — rather
 * than hand-copying the current enum lists into this file, which would just be a second place to
 * forget to update.
 */

const ALL_FAMILIES = ['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml'] as const;

/** Case-insensitive, hyphen/space-insensitive containment check — enum values are kebab-case
 *  slugs (e.g. "rounded-rectangle"), primer prose is plain English (e.g. "rounded rectangles"),
 *  and English pluralization already falls out for free from plain substring containment (e.g.
 *  "cylinder" is a substring of "cylinders"). */
function primerMentions(primerText: string, value: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/-/g, ' ');
  return normalize(primerText).includes(normalize(value));
}

describe('diagram-type-primers drift guard (010-ai-diagram-knowledge, T023)', () => {
  it.each(ALL_FAMILIES)("every enum value %s's tool set currently exposes is mentioned in its primer", (family) => {
    let model: DiagramModel = { diagramTypeId: family, nodes: [], edges: [], containers: [] };
    const tools = createDiagramTools(
      { getModel: () => model, setModel: (m) => { model = m; } },
      family,
    );

    const enumValues = new Set<string>();
    for (const tool of Object.values(tools)) {
      collectEnumValues((tool as { inputSchema: unknown }).inputSchema, enumValues);
    }
    // Sanity check on the instrument itself: every family's tool set has at least one enum field
    // (addNode's own `shape`) — an empty set here would mean collectEnumValues silently found
    // nothing and the test below would vacuously pass.
    expect(enumValues.size).toBeGreaterThan(0);

    const primer = getDiagramTypePrimer(family);
    expect(primer).toBeDefined();

    const missing = [...enumValues].filter((value) => !primerMentions(primer!.summary, value));
    expect(missing).toEqual([]);
  });
});
