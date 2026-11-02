/**
 * canvas-1bty.12: what the AI chat modules in apps/api/src/ai (the diagram tools, the family primers,
 * the standard prompt, the diagram summary) import as `@canvas/diagram-core`, from source. The build
 * aliases that package name to this file (scripts/build.mjs), so the bundle doesn't take diagram-core's
 * package entry and every icon manifest with it.
 */
export * from '../../diagram-core/src/model/diagram-ops.js';
export * from '../../diagram-core/src/model/standard-ops.js';
export * from '../../diagram-core/src/model/family-capabilities.js';
export * from '../../diagram-core/src/standards/kinds.js';
export * from '../../diagram-core/src/standards/authoring.js';
export { validate } from '../../diagram-core/src/standards/validator.js';
export { C4_BOUNDARY_ROLES, C4_ELEMENT_ROLES } from '../../diagram-core/src/dsl/c4.js';
export {
  ER_SOURCE_CARDINALITY_TOKENS,
  ER_TARGET_CARDINALITY_TOKENS,
} from '../../diagram-core/src/dsl/erd.js';
export { UML_RELATION_KINDS } from '../../diagram-core/src/dsl/uml.js';
export type {
  DiagramEdge,
  DiagramModel,
  NodeShape,
} from '../../diagram-core/src/model/diagram-model.js';
export type { StandardRules } from '../../diagram-core/src/standards/schema.js';
