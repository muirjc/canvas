import { detectDslFamily } from '@canvas/diagram-core';
import { getPool } from '../db/pool.js';
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

  const pool = getPool();
  let diagramTypeId: string;
  if (input.diagramTypeHint) {
    const { rows } = await pool.query<{ dsl_family: string }>(
      'SELECT dsl_family FROM diagram_types WHERE id = $1',
      [input.diagramTypeHint],
    );
    if (!rows[0]) {
      throw new DiagramTypeHintMismatchError(`Unknown diagram type hint: ${input.diagramTypeHint}`);
    }
    if (rows[0].dsl_family !== detectedFamily) {
      throw new DiagramTypeHintMismatchError(
        `The provided diagram type "${input.diagramTypeHint}" uses the "${rows[0].dsl_family}" DSL family, but this content looks like "${detectedFamily}".`,
      );
    }
    diagramTypeId = input.diagramTypeHint;
  } else {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM diagram_types WHERE dsl_family = $1 ORDER BY id LIMIT 1',
      [detectedFamily],
    );
    if (!rows[0]) {
      throw new UnrecognizedDslError(`No diagram type is registered for the "${detectedFamily}" DSL family.`);
    }
    diagramTypeId = rows[0].id;
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
