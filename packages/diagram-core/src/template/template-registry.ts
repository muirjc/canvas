import { architectureTemplateCompiler } from './architecture-template-compiler.js';
import { c4ContextTemplateCompiler } from './c4-context-template-compiler.js';
import { c4ComponentTemplateCompiler, c4ContainerTemplateCompiler, c4DeploymentTemplateCompiler } from './c4-levels-template-compiler.js';
import { erdTemplateCompiler } from './erd-template-compiler.js';
import { sequenceTemplateCompiler } from './sequence-template-compiler.js';
import { umlClassTemplateCompiler } from './uml-class-template-compiler.js';
import type { TemplateCompiler } from './types.js';

/**
 * Registry of template compilers by diagramTypeId, mirroring dsl/registry.ts's exact shape.
 * Shared by both the API (existence check before compiling) and the browser (the "Import from
 * Template" dialog filters its diagram-type picker to `id in templateCompilers`) -- adding a new
 * diagram type's template support is one new entry here, not a change to either consumer.
 */
export const templateCompilers: Record<string, TemplateCompiler> = {
  'c4-context': c4ContextTemplateCompiler,
  'c4-container': c4ContainerTemplateCompiler,
  'c4-component': c4ComponentTemplateCompiler,
  'c4-deployment': c4DeploymentTemplateCompiler,
  sequence: sequenceTemplateCompiler,
  erd: erdTemplateCompiler,
  uml: umlClassTemplateCompiler,
  network: architectureTemplateCompiler,
  deployment: architectureTemplateCompiler,
  'cloud-infrastructure': architectureTemplateCompiler,
};

export function getTemplateCompiler(diagramTypeId: string): TemplateCompiler | undefined {
  return templateCompilers[diagramTypeId];
}
