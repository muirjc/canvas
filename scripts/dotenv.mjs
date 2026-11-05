// canvas-mywp: reads apps/api-py/.env the way `uv run --env-file` does for the simple files Canvas uses:
// KEY=VALUE lines, blank lines and `#` comments skipped, optional single or double quotes around the value,
// and a ` #` comment after an unquoted value dropped. Shared by scripts/dev-local.mjs and the e2e global setup.
import { existsSync, readFileSync } from 'node:fs';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** The file's settings, or an empty object when it doesn't exist. */
export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = line.match(LINE);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    values[match[1]] = value;
  }
  return values;
}
