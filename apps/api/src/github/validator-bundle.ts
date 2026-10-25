import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * canvas-3s5.3: the CI validator bundle (packages/validator-cli, built to dist/validator.mjs) and
 * the example workflow beside it. Canvas commits the bundle to `.canvas/validator.mjs` with every
 * submission -- unchanged content leaves the repository's tree unchanged, so it only produces a
 * diff when the validator itself changes. Read once and cached.
 *
 * Found at CANVAS_VALIDATOR_DIR, else packages/validator-cli/dist relative to this file (the same
 * from src/ under tsx and dist/ in the image). Missing (not built) = submissions skip the file.
 * Tests get it only via CANVAS_VALIDATOR_DIR, so whether a developer has built it locally can't
 * change their results.
 */
const DEFAULT_DIR = fileURLToPath(new URL('../../../../packages/validator-cli/dist/', import.meta.url));

function validatorDir(): string | null {
  if (process.env.CANVAS_VALIDATOR_DIR) return process.env.CANVAS_VALIDATOR_DIR.replace(/\/?$/, '/');
  return process.env.NODE_ENV === 'test' ? null : DEFAULT_DIR;
}

const cache = new Map<string, string | null>();

function readCached(file: string): string | null {
  const dir = validatorDir();
  if (!dir) return null;
  const key = dir + file;
  if (!cache.has(key)) {
    try {
      cache.set(key, readFileSync(key, 'utf8'));
    } catch {
      cache.set(key, null);
    }
  }
  return cache.get(key) ?? null;
}

/** The bundled validator, or null when it hasn't been built. */
export function validatorBundle(): string | null {
  return readCached('validator.mjs');
}

/** The example workflow (.github/workflows/canvas-diagrams.yml for the repository), or null. */
export function exampleWorkflow(): string | null {
  return readCached('canvas-diagrams.yml');
}

/** Tests only: forget what was read. */
export function resetValidatorBundleCache(): void {
  cache.clear();
}
