import type { NodeShape } from '../model/diagram-model.js';

export interface IconLibraryRef {
  libraryId: string;
  libraryVersion: string;
}

export interface ColorPaletteEntry {
  /** Semantic role this color applies to, e.g. "person", "system", "container" (DiagramNode.role). */
  role: string;
  colorHex: string;
}

export interface FontConstraints {
  family?: string;
  minSize?: number;
  maxSize?: number;
}

/**
 * An admin-defined, versioned rule set bound to one DiagramType (data-model.md's Standard
 * entity). Structured and machine-evaluable — Constitution II: "machine-checked, not advisory."
 */
export interface StandardRules {
  /** If non-empty, every node's shape must be one of these. */
  allowedShapeIds: NodeShape[];
  /** Shapes that MUST appear at least once somewhere in a compliant diagram of this type. */
  mandatoryShapeIds: NodeShape[];
  /** If non-empty, every node icon reference must match one of these (libraryId + version). */
  allowedIconLibraryRefs: IconLibraryRef[];
  /** Required color per semantic node role. */
  colorPalette: ColorPaletteEntry[];
  fontConstraints?: FontConstraints;
}

export function emptyStandardRules(): StandardRules {
  return {
    allowedShapeIds: [],
    mandatoryShapeIds: [],
    allowedIconLibraryRefs: [],
    colorPalette: [],
  };
}
