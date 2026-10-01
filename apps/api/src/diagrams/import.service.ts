import { detectDslFamily } from '@canvas/diagram-core';
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
}

/**
 * Imports raw Mermaid DSL as a new diagram (FR-018). The one thing native creation doesn't need
 * that import does: the diagram type isn't known up front, so it's resolved from the DSL's own
 * header (detectDslFamily) — optionally narrowed by diagramTypeHint when the family is shared by
 * several diagram types (e.g. "architecture" spans network/deployment/cloud-infrastructure).
 */
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
    const row = await db
      .selectFrom('diagram_types')
      .select('id')
      .where('dsl_family', '=', detectedFamily)
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      throw new UnrecognizedDslError(`No diagram type is registered for the "${detectedFamily}" DSL family.`);
    }
    diagramTypeId = row.id;
  }

  // Reuses createDiagram's existing parse/validate/versioning — a ParseError from bad syntax
  // surfaces as the same structured DslValidationError callers already handle (FR-019).
  return createDiagram({
    name: input.name,
    diagramTypeId,
    projectId: input.projectId,
    ownerId: input.ownerId,
    initialDslContent: input.dslContent,
  });
}
