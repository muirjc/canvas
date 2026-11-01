/**
 * The parts of diagram-core the bridge serves, imported from source (like packages/validator-cli):
 * the package entry also pulls in the icon libraries, which the bridge never needs -- the Python
 * service sends icon artwork with a render request.
 */
export { detectDslFamily } from '../../diagram-core/src/dsl/detect.js';
export { getDslFamily } from '../../diagram-core/src/dsl/registry.js';
export { isParseSuccess } from '../../diagram-core/src/dsl/types.js';
export { toPortableMermaid } from '../../diagram-core/src/dsl/portable-mermaid.js';
export { validate } from '../../diagram-core/src/standards/validator.js';
export { checkStandardDefinition } from '../../diagram-core/src/standards/definition-check.js';
export { renderToSvg } from '../../diagram-core/src/render/svg-renderer.js';
export { updateEmbeds, type EmbedSource } from '../../diagram-core/src/embeds/markdown-embeds.js';
export type { DiagramModel } from '../../diagram-core/src/model/diagram-model.js';
export type { StandardRules } from '../../diagram-core/src/standards/schema.js';
