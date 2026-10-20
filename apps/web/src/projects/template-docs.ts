import architectureTemplate from '../../../../docs/architecture-template.md?raw';
import c4ContextTemplate from '../../../../docs/c4-context-template.md?raw';
import c4LevelsTemplate from '../../../../docs/c4-levels-template.md?raw';
import erdTemplate from '../../../../docs/erd-template.md?raw';
import sequenceTemplate from '../../../../docs/sequence-template.md?raw';
import umlClassTemplate from '../../../../docs/uml-class-template.md?raw';

/**
 * canvas-73s.1-.5: the blank intake template for each diagram type with a template compiler
 * (diagram-core's templateCompilers), bundled from docs/ so the Import from Template dialog can
 * offer it as a download -- the docs are the single source; nothing is copied.
 */
const C4_LEVELS = { fileName: 'c4-levels-template.md', text: c4LevelsTemplate };
const ARCHITECTURE = { fileName: 'architecture-template.md', text: architectureTemplate };

export const TEMPLATE_DOCS: Record<string, { fileName: string; text: string }> = {
  'c4-context': { fileName: 'c4-context-template.md', text: c4ContextTemplate },
  'c4-container': C4_LEVELS,
  'c4-component': C4_LEVELS,
  'c4-deployment': C4_LEVELS,
  sequence: { fileName: 'sequence-template.md', text: sequenceTemplate },
  erd: { fileName: 'erd-template.md', text: erdTemplate },
  uml: { fileName: 'uml-class-template.md', text: umlClassTemplate },
  network: ARCHITECTURE,
  deployment: ARCHITECTURE,
  'cloud-infrastructure': ARCHITECTURE,
};
