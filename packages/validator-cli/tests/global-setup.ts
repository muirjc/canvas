import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Builds dist/validator.mjs once so the tests can run the real, bundled validator. */
export default function setup(): void {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd, stdio: 'pipe' });
}
