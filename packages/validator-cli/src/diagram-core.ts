/**
 * The parts of diagram-core the validator uses, imported from source rather than the package
 * entry: the entry also re-exports the icon libraries (650 KB of Azure artwork, kept alive by the
 * template compilers), which a CI validator never needs. esbuild bundles these files directly.
 */
export { getDslFamily } from '../../diagram-core/src/dsl/registry.js';
export { validate, type Violation } from '../../diagram-core/src/standards/validator.js';
export { renderToSvg } from '../../diagram-core/src/render/svg-renderer.js';
export { findElementLine } from '../../diagram-core/src/standards/locate.js';
export { emptyStandardRules, type StandardRules } from '../../diagram-core/src/standards/schema.js';
export type { DiagramModel } from '../../diagram-core/src/model/diagram-model.js';
export { updateEmbeds, type EmbedResult, type EmbedSource } from '../../diagram-core/src/embeds/markdown-embeds.js';
