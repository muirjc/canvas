import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { awsIconsManifest } from '../../src/libraries/aws-icons.js';
import { azureIconsManifest } from '../../src/libraries/azure-icons.js';
import { MERMAID_ARCHITECTURE_ICON_IDS, mermaidArchitectureIconsManifest } from '../../src/libraries/mermaid-architecture-icons.js';

/**
 * canvas-1bty.15.5: the Python template compilers check icon ids against these libraries, but carry only the ids
 * (apps/api-py/.../diagram_core/icon_catalogue.json), not the 640 KB of artwork. This test fails when the file
 * drifts from the manifests here. Regenerate with:
 *   UPDATE_CATALOGUE=1 npx vitest run tests/contract/python-icon-catalogue.test.ts
 */
const FILE = fileURLToPath(new URL('../../../../apps/api-py/src/canvas_api/diagram_core/icon_catalogue.json', import.meta.url));

function catalogue() {
  const library = (m: { id: string; version: string; icons: { id: string }[] }, withIds: boolean) => ({
    libraryId: m.id,
    libraryVersion: m.version,
    ...(withIds ? { iconIds: m.icons.map((i) => i.id) } : {}),
  });
  return {
    // The bundled AWS manifest is a placeholder (a deployment may serve the real set), so its ids aren't checked.
    aws: library(awsIconsManifest, false),
    azure: library(azureIconsManifest, true),
    mermaid: { ...library(mermaidArchitectureIconsManifest, true), builtInIds: [...MERMAID_ARCHITECTURE_ICON_IDS] },
  };
}

describe('Python icon catalogue', () => {
  it('matches the icon manifests', () => {
    const expected = JSON.stringify(catalogue(), null, 2) + '\n';
    if (process.env.UPDATE_CATALOGUE === '1') writeFileSync(FILE, expected);
    expect(readFileSync(FILE, 'utf-8')).toBe(expected);
  });
});
