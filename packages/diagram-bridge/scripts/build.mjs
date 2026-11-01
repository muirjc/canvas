// canvas-1bty.4: bundles the bridge into one dependency-free file, dist/bridge.mjs.
import { mkdirSync, statSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/bridge.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  legalComments: 'none',
  banner: {
    js: [
      '// Canvas diagram-core bridge -- generated; do not edit.',
      // yaml's CommonJS build calls require(); give the ES module bundle one.
      "import { createRequire as __canvasCreateRequire } from 'node:module'; const require = __canvasCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'warning',
});
// The bundle's size only.
// bearer:disable javascript_lang_logger_leak
console.log(`dist/bridge.mjs ${(statSync('dist/bridge.mjs').size / 1024).toFixed(0)} KB`);
