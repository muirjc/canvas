import { azureIconsManifest, awsIconsManifest, genericShapesManifest, c4NotationManifest } from '@canvas/diagram-core';
import { ingestLibrary } from '../libraries/library.service.js';

/** Ingests every bundled Icon/Shape Library (FR-008, FR-010). Adding a new one is one more call. */
export async function seedLibraries(): Promise<void> {
  await ingestLibrary(genericShapesManifest);
  await ingestLibrary(c4NotationManifest);
  await ingestLibrary(azureIconsManifest);
  await ingestLibrary(awsIconsManifest);
}
