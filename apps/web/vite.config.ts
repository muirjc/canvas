import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// canvas-qrvn: the bundle includes third-party packages whose licences require their notices to
// travel with it, so every build publishes the repository's generated notices file (and Canvas's
// own licence) next to index.html.
function legalNotices(): Plugin {
  const files = [
    { fileName: 'third-party-notices.txt', source: '../../THIRD-PARTY-NOTICES.md' },
    { fileName: 'license.txt', source: '../../LICENSE' },
  ];
  return {
    name: 'canvas-legal-notices',
    apply: 'build',
    generateBundle() {
      for (const { fileName, source } of files) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: readFileSync(new URL(source, import.meta.url), 'utf8'),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), legalNotices()],
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
