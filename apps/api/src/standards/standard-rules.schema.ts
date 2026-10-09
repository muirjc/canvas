import { z } from 'zod';
import { checkStandardDefinition, RULE_IDS, type DefinitionIssue, type NodeShape, type StandardRules } from '@canvas/diagram-core';

/**
 * canvas-tfr: request-body validation for creating/updating a standard. Structural shape is checked
 * here (diagram-core has no Zod dependency, so this mirrors its StandardRules type); semantic
 * coherence for the diagram family (kind ids, shapes, hex colors, connector references...) is
 * diagram-core's `checkStandardDefinition`, so the browser editor can run the identical check
 * before saving.
 */
const severity = z.enum(['error', 'warning', 'info']);
const nodeShape = z.string() as unknown as z.ZodType<NodeShape>;

const elementKind = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  shapes: z.array(nodeShape).default([]),
  approvedFills: z.array(z.string()).default([]),
  approvedStrokes: z.array(z.string()).optional(),
  match: z.object({ role: z.string(), external: z.boolean().optional() }).optional(),
  minCount: z.number().int().optional(),
  maxCount: z.number().int().optional(),
  requireConnection: z.boolean().optional(),
});

const connectorRule = z.object({
  id: z.string(),
  label: z.string(),
  from: z.string(),
  to: z.string(),
  lineStyles: z.array(z.enum(['solid', 'dotted', 'thick', 'invisible'])).optional(),
  arrows: z.array(z.enum(['none', 'source', 'target', 'both', 'cross', 'open'])).optional(),
  approvedStrokes: z.array(z.string()).optional(),
  requireLabel: z.boolean().optional(),
  maxPerSource: z.number().int().min(0).optional(),
});

export const standardBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  // v1
  allowedShapeIds: z.array(nodeShape).default([]),
  mandatoryShapeIds: z.array(nodeShape).default([]),
  allowedIconLibraryRefs: z.array(z.object({ libraryId: z.string(), libraryVersion: z.string() })).default([]),
  colorPalette: z.array(z.object({ role: z.string(), colorHex: z.string() })).default([]),
  fontConstraints: z
    .object({ family: z.string().optional(), minSize: z.number().optional(), maxSize: z.number().optional() })
    .optional(),
  // v2
  elementKinds: z.array(elementKind).optional(),
  connectorRules: z.array(connectorRule).optional(),
  connectorPolicy: z.enum(['listed-only', 'any']).optional(),
  containers: z.object({ allowed: z.boolean(), allowedRoles: z.array(z.string()).optional() }).optional(),
  requireKnownKinds: z.boolean().optional(),
  severityOverrides: z.partialRecord(z.enum(RULE_IDS), severity).optional(),
  guidance: z.string().optional(),
});

export type StandardBody = z.infer<typeof standardBodySchema>;

export type ParsedStandardBody =
  | { ok: true; rules: StandardRules; name?: string; description?: string | null }
  | { ok: false; issues: DefinitionIssue[] };

/** Parses a request body and checks it against the diagram family. */
export function parseStandardBody(body: unknown, family: string): ParsedStandardBody {
  const parsed = standardBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const { name, description, ...rules } = parsed.data;
  const issues = checkStandardDefinition(rules, family);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, rules, name, description };
}
