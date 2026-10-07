import { azureIconsManifest, awsIconsManifest, genericShapesManifest } from '@canvas/diagram-core';
import { ingestLibrary } from '../libraries/library.service.js';

/** Ingests every bundled Icon/Shape Library (FR-008, FR-010). Adding a new one is one more call.
 *  canvas-wrk: c4-notation was removed entirely — every one of its 6 entries was either a
 *  non-visual shape-alias sentinel exactly duplicating C4's own shape toolbar (person/system/
 *  container/component/database), or outright broken ('boundary' referenced a nonexistent
 *  NodeShape and, being an icon pick, would have added a plain node rather than an actual C4
 *  boundary container regardless). C4 diagram types now ship zero default palette libraries —
 *  getAddableShapes('c4')'s shape toolbar is the one correct, working way to add a C4 element. */
export async function seedLibraries(): Promise<void> {
  await ingestLibrary(genericShapesManifest);
  await ingestLibrary(azureIconsManifest);
  await ingestLibrary(awsIconsManifest);
}
