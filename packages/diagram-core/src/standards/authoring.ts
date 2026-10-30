import type { NodeShape } from '../model/diagram-model.js';
import type { AuthoringScope, StandardRules } from './schema.js';

/**
 * canvas-7ewa / canvas-wid: what authors can add besides a standard's element kinds -- the one
 * rule the editor rail, the Palette, the AI tools and the validator all read.
 *
 * With no explicit `authoring`, existing standards keep their behaviour: a strict standard
 * (requireKnownKinds with kinds defined) offers only its kinds; otherwise a non-empty
 * allowedShapeIds / allowedIconLibraryRefs means 'listed', and an empty one means 'all'.
 */
export interface EffectiveAuthoring {
  shapes: AuthoringScope;
  icons: AuthoringScope;
}

export function effectiveAuthoring(rules?: StandardRules): EffectiveAuthoring {
  if (!rules) return { shapes: 'all', icons: 'all' };
  const strict = Boolean(rules.requireKnownKinds) && (rules.elementKinds?.length ?? 0) > 0;
  return {
    shapes: rules.authoring?.shapes ?? (strict ? 'none' : rules.allowedShapeIds.length > 0 ? 'listed' : 'all'),
    icons: rules.authoring?.icons ?? (strict ? 'none' : rules.allowedIconLibraryRefs.length > 0 ? 'listed' : 'all'),
  };
}

/** The generic shapes to offer, from the family's own list (keeps that list's order). */
export function offeredShapes<T extends NodeShape>(familyShapes: readonly T[], rules?: StandardRules): T[] {
  const { shapes } = effectiveAuthoring(rules);
  if (shapes === 'none') return [];
  if (shapes === 'listed') return familyShapes.filter((shape) => rules!.allowedShapeIds.includes(shape));
  return [...familyShapes];
}

/** The shape-alias "icons" (Rectangle, Diamond / Decision, ...) are generic shapes, not artwork. */
export const SHAPE_ALIAS_LIBRARY_ID = 'generic';

/** Whether icons from this library may be offered (any version: a standard lists libraries). */
export function iconLibraryOffered(libraryId: string, rules?: StandardRules): boolean {
  if (libraryId === SHAPE_ALIAS_LIBRARY_ID) return effectiveAuthoring(rules).shapes === 'all';
  const { icons } = effectiveAuthoring(rules);
  if (icons === 'none') return false;
  if (icons === 'listed') return rules!.allowedIconLibraryRefs.some((ref) => ref.libraryId === libraryId);
  return true;
}
