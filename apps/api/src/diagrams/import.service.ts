import { detectDslFamily, getDslFamily, isParseSuccess } from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { createDiagram, type DiagramRecord } from './diagram.service.js';

export class UnrecognizedDslError extends Error {}
export class DiagramTypeHintMismatchError extends Error {}

export interface ImportDiagramInput {
  name: string;
  projectId: string;
  ownerId: string;
  dslContent: string;
  diagramTypeHint?: string;
  /** canvas-tmpr: hidden and "Not saved" until the creator's first Save, like Create with AI. */
  draft?: boolean;
}

/**
 * Imports raw Mermaid DSL as a new diagram (FR-018). The one thing native creation doesn't need
 * that import does: the diagram type isn't known up front, so it's resolved from the DSL's own
 * header (detectDslFamily) — then narrowed to one type: the explicit diagramTypeHint when given,
 * otherwise the type the header names (resolveTypeWithoutHint).
 */
/** canvas-cc3: each family's generic type, used when the DSL header doesn't name a registered type. */
const FAMILY_DEFAULT_TYPE: Record<string, string> = {
  flowchart: 'flowchart',
  c4: 'c4-context',
  sequence: 'sequence',
  erd: 'erd',
  uml: 'uml',
  architecture: 'cloud-infrastructure',
};

/**
 * canvas-cc3: picks the diagram type for an import with no hint. In order: the type the DSL header
 * itself names (the parsers set model.diagramTypeId -- e.g. C4Context -> c4-context, C4Container ->
 * c4-container), when that type is registered for the family; else the family's generic type; else
 * any type of the family. Previously it was simply the first type of the family by id, so a
 * C4Context file landed on c4-code -- and, since every built-in type has its own standard, got the
 * wrong standard, kind picker and AI tools too.
 */
async function resolveTypeWithoutHint(dslContent: string, family: string): Promise<string> {
  const db = getDb();
  const registered = await db.selectFrom('diagram_types').select('id').where('dsl_family', '=', family).orderBy('id').execute();
  const ids = new Set(registered.map((r) => r.id));
  if (ids.size === 0) {
    throw new UnrecognizedDslError(`No diagram type is registered for the "${family}" DSL family.`);
  }
  const parsed = getDslFamily(family)?.parse(dslContent);
  // A parse failure is reported properly by createDiagram below; it just can't name a type here.
  const fromHeader = parsed && isParseSuccess(parsed) ? parsed.model.diagramTypeId : undefined;
  if (fromHeader && ids.has(fromHeader)) return fromHeader;
  const familyDefault = FAMILY_DEFAULT_TYPE[family];
  if (familyDefault && ids.has(familyDefault)) return familyDefault;
  return registered[0].id;
}

export async function importDiagram(input: ImportDiagramInput): Promise<DiagramRecord> {
  const detectedFamily = detectDslFamily(input.dslContent);
  if (!detectedFamily) {
    throw new UnrecognizedDslError(
      'Could not recognize this text as any supported Mermaid diagram type (expected a header line such as "flowchart TD", "C4Context", "sequenceDiagram", "erDiagram", "classDiagram", or "architecture-beta").',
    );
  }

  const db = getDb();
  let diagramTypeId: string;
  if (input.diagramTypeHint) {
    const row = await db
      .selectFrom('diagram_types')
      .select('dsl_family')
      .where('id', '=', input.diagramTypeHint)
      .executeTakeFirst();
    if (!row) {
      throw new DiagramTypeHintMismatchError(`Unknown diagram type hint: ${input.diagramTypeHint}`);
    }
    if (row.dsl_family !== detectedFamily) {
      throw new DiagramTypeHintMismatchError(
        `The provided diagram type "${input.diagramTypeHint}" uses the "${row.dsl_family}" DSL family, but this content looks like "${detectedFamily}".`,
      );
    }
    diagramTypeId = input.diagramTypeHint;
  } else {
    diagramTypeId = await resolveTypeWithoutHint(input.dslContent, detectedFamily);
  }

  // Reuses createDiagram's existing parse/validate/versioning — a ParseError from bad syntax
  // surfaces as the same structured DslValidationError callers already handle (FR-019).
  return createDiagram({
    name: input.name,
    diagramTypeId,
    projectId: input.projectId,
    ownerId: input.ownerId,
    initialDslContent: input.dslContent,
    draft: input.draft,
  });
}
