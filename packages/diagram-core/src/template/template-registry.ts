import { c4ContextTemplateCompiler } from './c4-context-template-compiler.js';
import type { TemplateCompiler } from './types.js';

/**
 * Registry of template compilers by diagramTypeId, mirroring dsl/registry.ts's exact shape.
 * Shared by both the API (existence check before compiling) and the browser (the "Import from
 * Template" dialog filters its diagram-type picker to `id in templateCompilers`) -- adding a new
 * diagram type's template support is one new entry here, not a change to either consumer.
 */
export const templateCompilers: Record<string, TemplateCompiler> = {
  'c4-context': c4ContextTemplateCompiler,
};

export function getTemplateCompiler(diagramTypeId: string): TemplateCompiler | undefined {
  return templateCompilers[diagramTypeId];
}
