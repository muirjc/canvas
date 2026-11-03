import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AWS_ICONS_VERSION, LEGACY_AWS_PLACEHOLDER_VERSION, awsIconsManifest } from '../../src/libraries/aws-icons.js';
import { azureIconsManifest } from '../../src/libraries/azure-icons.js';
import { genericShapesManifest } from '../../src/libraries/generic.js';
import { mermaidArchitectureIconsManifest } from '../../src/libraries/mermaid-architecture-icons.js';

/**
 * canvas-1bty phase 12a: the Python catalog seed (apps/api-py/src/canvas_api/seed/) loads the bundled icon/shape
 * libraries from JSON copies of the manifests here, one compact file per library, plus the AWS versions. This test
 * fails when a copy drifts from its manifest. Regenerate with:
 *   UPDATE_SEED_LIBRARIES=1 npx vitest run tests/contract/python-seed-libraries.test.ts
 */
const DIR = new URL('../../../../apps/api-py/src/canvas_api/seed/manifests/', import.meta.url);

const FILES: Record<string, unknown> = {
  'generic.json': genericShapesManifest,
  'azure-icons.json': azureIconsManifest,
  'aws-icons.json': awsIconsManifest,
  'mermaid-architecture.json': mermaidArchitectureIconsManifest,
  'versions.json': { awsIconsVersion: AWS_ICONS_VERSION, legacyAwsPlaceholderVersion: LEGACY_AWS_PLACEHOLDER_VERSION },
};

describe('Python seed libraries', () => {
  for (const [name, value] of Object.entries(FILES)) {
    it(`${name} matches its manifest`, () => {
      const file = fileURLToPath(new URL(name, DIR));
      const expected = JSON.stringify(value) + '\n';
      if (process.env.UPDATE_SEED_LIBRARIES === '1') writeFileSync(file, expected);
      expect(readFileSync(file, 'utf-8')).toBe(expected);
    });
  }
});
