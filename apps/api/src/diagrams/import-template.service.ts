import { getTemplateCompiler } from '@canvas/diagram-core';
import { createDiagram, DslValidationError, type DiagramRecord } from './diagram.service.js';

export class UnsupportedTemplateTypeError extends Error {}

export interface ImportTemplateInput {
  name: string;
  projectId: string;
  ownerId: string;
  diagramTypeId: string;
  templateContent: string;
}

/**
 * Imports a filled-in Markdown "intake template" (docs/c4-context-template.md and future
 * per-diagram-type siblings) as a new diagram. Unlike raw DSL import (import.service.ts),
 * `diagramTypeId` is a required input here rather than auto-detected -- a filled-in template has
 * no header line the way Mermaid DSL text does, so the caller (the UI's type picker) must say
 * which diagram type template this is.
 */
export async function importTemplate(input: ImportTemplateInput): Promise<DiagramRecord> {
  const compiler = getTemplateCompiler(input.diagramTypeId);
  if (!compiler) {
    throw new UnsupportedTemplateTypeError(`No template importer is available for diagram type "${input.diagramTypeId}".`);
  }

  const result = compiler.compile(input.templateContent);
  if ('errors' in result) {
    throw new DslValidationError(result.errors);
  }

  // Reuses createDiagram's existing parse/validate/versioning exactly like import.service.ts's
  // importDiagram does -- the compiled DSL goes through the identical parseC4/standards-
  // validation/persistence path every other diagram creation path already goes through.
  return createDiagram({
    name: input.name,
    diagramTypeId: input.diagramTypeId,
    projectId: input.projectId,
    ownerId: input.ownerId,
    initialDslContent: result.dsl,
  });
}
