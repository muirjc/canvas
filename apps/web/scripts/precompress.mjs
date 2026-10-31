// canvas-r3y: writes .br and .gz copies of the built web app's text files (JS, CSS, HTML, SVG,
// text), so the API serves them compressed (@fastify/static preCompressed) with no work per request.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = process.argv[2] ?? new URL('../dist', import.meta.url).pathname;
const TEXT = /\.(js|mjs|css|html|svg|txt|json|map)$/;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (TEXT.test(name) && statSync(path).size > 1024) {
      const body = readFileSync(path);
      writeFileSync(`${path}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      writeFileSync(`${path}.gz`, gzipSync(body, { level: 9 }));
    }
  }
}
walk(root);
