import type { ParseError } from '../dsl/types.js';

export type TemplateCompileResult = { dsl: string } | { errors: ParseError[] };

/**
 * A per-diagram-type template compiler: turns a filled-in Markdown "intake form" (like
 * docs/c4-context-template.md) into Mermaid DSL text for that diagram type's family. Reuses the
 * existing `ParseError` shape so a compile failure renders through the same
 * UnsupportedElementNotice UI a raw-DSL parse error already does, with no frontend changes.
 * Deliberately produces DSL *text*, not a DiagramModel directly -- the generated text is handed to
 * the family's own real parser (via createDiagram's existing initialDslContent path), so a
 * compiled template can never produce a model the parser itself wouldn't also accept from a human.
 */
export interface TemplateCompiler {
  compile(markdownText: string): TemplateCompileResult;
}
