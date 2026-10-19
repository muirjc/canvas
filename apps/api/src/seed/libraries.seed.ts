import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AWS_ICONS_VERSION,
  LEGACY_AWS_PLACEHOLDER_VERSION,
  awsIconsManifest,
  azureIconsManifest,
  genericShapesManifest,
  mermaidArchitectureIconsManifest,
  type IconShapeLibraryManifest,
} from '@canvas/diagram-core';
import { getDb } from '../db/client.js';
import { ingestLibrary } from '../libraries/library.service.js';

/**
 * jmuir-dtu.29: where a deployment's locally generated AWS icon library lives -- the repo root's
 * vendor-icons/ folder (gitignored apart from its README; the Docker image copies it). The path
 * resolves to the repo root from both src/seed (dev) and dist/seed (the image), and can be
 * overridden with AWS_ICONS_MANIFEST.
 */
const DEFAULT_AWS_ICONS_MANIFEST = fileURLToPath(new URL('../../../../vendor-icons/aws-icons.json', import.meta.url));

export interface SeedLibrariesOptions {
  /** Path to a generated AWS icon manifest; defaults to AWS_ICONS_MANIFEST, then vendor-icons/. */
  awsIconsManifestPath?: string;
}

/** Ingests every bundled Icon/Shape Library (FR-008, FR-010). Adding a new one is one more call.
 *  canvas-wrk: c4-notation was removed entirely — every one of its 6 entries was either a
 *  non-visual shape-alias sentinel exactly duplicating C4's own shape toolbar (person/system/
 *  container/component/database), or outright broken ('boundary' referenced a nonexistent
 *  NodeShape and, being an icon pick, would have added a plain node rather than an actual C4
 *  boundary container regardless). C4 diagram types now ship zero default palette libraries —
 *  getAddableShapes('c4')'s shape toolbar is the one correct, working way to add a C4 element. */
export async function seedLibraries(options: SeedLibrariesOptions = {}): Promise<void> {
  await ingestLibrary(genericShapesManifest);
  await ingestLibrary(azureIconsManifest);
  // jmuir-dtu.29: real AWS artwork when this deployment generated it, the placeholders otherwise.
  await ingestLibrary(loadGeneratedAwsIcons(options.awsIconsManifestPath) ?? awsIconsManifest);
  await removeLegacyAwsPlaceholderVersion();
  await ingestLibrary(mermaidArchitectureIconsManifest);
}

function loadGeneratedAwsIcons(explicitPath: string | undefined): IconShapeLibraryManifest | undefined {
  const path = explicitPath ?? process.env.AWS_ICONS_MANIFEST ?? DEFAULT_AWS_ICONS_MANIFEST;
  if (!existsSync(path)) return undefined;
  const manifest = JSON.parse(readFileSync(path, 'utf-8')) as IconShapeLibraryManifest;
  if (manifest.id !== 'aws-icons' || manifest.version !== AWS_ICONS_VERSION) {
    throw new Error(
      `${path} is ${manifest.id}@${manifest.version}; expected aws-icons@${AWS_ICONS_VERSION}. ` +
        'Regenerate it with packages/diagram-core/scripts/generate-aws-icons.mjs.',
    );
  }
  return manifest;
}

/** The aws-icons library used to be seeded as '2024.1-placeholder'; saved references to it are
 *  upgraded on read (diagram-core front-matter.ts), so the old version only duplicates palette
 *  entries. Its icons and keywords go with it (ON DELETE CASCADE). */
async function removeLegacyAwsPlaceholderVersion(): Promise<void> {
  await getDb()
    .deleteFrom('icon_libraries')
    .where('id', '=', 'aws-icons')
    .where('version', '=', LEGACY_AWS_PLACEHOLDER_VERSION)
    .execute();
}
