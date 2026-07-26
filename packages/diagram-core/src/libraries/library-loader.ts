/**
 * Icon/Shape Library contract (Constitution V — Extensible Symbol Libraries).
 *
 * Adding a new icon set, or a new version of an existing one, is exactly one `loadLibrary()`
 * call with a new manifest. No other diagram-core code (parsers, serializers, validator,
 * renderer) needs to change to support it.
 */

import { sanitizeSvgFragment } from './svg-sanitizer.js';

export interface IconManifestEntry {
  id: string;
  displayName: string;
  keywords: string[];
  category: string;
  /** Pointer to the SVG asset (file path, URL, or blob-store key depending on deployment). */
  assetRef: string;
}

export interface IconShapeLibraryManifest {
  id: string;
  version: string;
  /** Required (non-empty) for vendor libraries such as Azure/AWS icon sets. */
  license?: string;
  icons: IconManifestEntry[];
}

export interface Icon extends IconManifestEntry {
  libraryId: string;
  libraryVersion: string;
}

export interface IconShapeLibrary {
  id: string;
  version: string;
  license?: string;
  icons: Icon[];
}

export class LibraryValidationError extends Error {}

function assertUniqueIconIds(manifest: IconShapeLibraryManifest): void {
  const seen = new Set<string>();
  for (const icon of manifest.icons) {
    if (seen.has(icon.id)) {
      throw new LibraryValidationError(
        `Duplicate icon id "${icon.id}" in library ${manifest.id}@${manifest.version}`,
      );
    }
    seen.add(icon.id);
  }
}

/**
 * Loads (validates and normalizes) an icon/shape library manifest into a queryable
 * IconShapeLibrary. This is the *only* integration point for adding a new library or library
 * version — see data-model.md's IconShapeLibrary/Icon entities.
 */
export function loadLibrary(manifest: IconShapeLibraryManifest): IconShapeLibrary {
  if (!manifest.id || !manifest.version) {
    throw new LibraryValidationError('Library manifest requires both id and version');
  }
  assertUniqueIconIds(manifest);

  return {
    id: manifest.id,
    version: manifest.version,
    license: manifest.license,
    icons: manifest.icons.map((entry) => ({
      ...entry,
      assetRef: sanitizeSvgFragment(entry.assetRef),
      libraryId: manifest.id,
      libraryVersion: manifest.version,
    })),
  };
}

export function searchIcons(library: IconShapeLibrary, query: string): Icon[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return library.icons;
  return library.icons.filter(
    (icon) =>
      icon.displayName.toLowerCase().includes(normalized) ||
      icon.id.toLowerCase().includes(normalized) ||
      icon.keywords.some((keyword) => keyword.toLowerCase().includes(normalized)),
  );
}
