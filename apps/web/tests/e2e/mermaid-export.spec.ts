// canvas-8ucs: every golden-corpus diagram's Mermaid export -- what a download or a GitHub submission holds --
// draws in real Mermaid, at the version GitHub runs (the `mermaid` devDependency; move it with
// GITHUB_MERMAID_VERSION in diagram-core's mermaid-version.ts). Both the text as typed and the text as Canvas
// saves it are checked: the export always writes the diagram again in Canvas's own form.
//
// Needs no app or database: it only draws text in a blank page.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { GITHUB_MERMAID_VERSION, toPortableMermaid } from '@canvas/diagram-core';

const require = createRequire(import.meta.url);
const CASES = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/diagram-core/corpus/cases');

// Cases that can't draw, and why. A case that starts drawing fails the test until it's taken off this list.
const KNOWN_FAILURES: Record<string, string> = {
  'flowchart-mermaid12-3': "Mermaid 12.3's BPMN shapes; GitHub's 12.2 has no such shape",
  'flowchart-mermaid12-shapes': 'its image node points at an address the test browser has no network for',
  'flowchart-object-prototype-ids': "Mermaid's own crash on a node named `constructor`",
  'uml-object-prototype-ids': "Mermaid's own crash on a class named `constructor`",
};

declare global {
  interface Window {
    mermaid: {
      initialize(config: Record<string, unknown>): void;
      render(id: string, text: string): Promise<{ svg: string }>;
    };
  }
}

test('every corpus diagram exports as Mermaid that GitHub can draw', async ({ page }) => {
  const version = (require('mermaid/package.json') as { version: string }).version;
  expect(version, 'the mermaid devDependency is the version GitHub runs').toBe(GITHUB_MERMAID_VERSION.version);

  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') });
  await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }));

  const failed = new Map<string, string>();
  let drawn = 0;
  for (const name of readdirSync(CASES).sort()) {
    const saved = join(CASES, name, 'expected', 'serialized.mmd');
    // A case with no saved form is an error case: text Canvas refuses, so it never exports.
    if (!existsSync(saved)) continue;
    for (const [form, file] of [
      ['typed', join(CASES, name, 'input.mmd')],
      ['saved', saved],
    ] as const) {
      const text = toPortableMermaid(readFileSync(file, 'utf8'), { stripFrontMatter: true });
      const error = await page.evaluate(async (t) => {
        try {
          await window.mermaid.render(`d${Math.random().toString(36).slice(2)}`, t);
          return null;
        } catch (e) {
          return String((e as Error)?.message ?? e).split('\n')[0];
        }
      }, text);
      if (error === null) drawn += 1;
      else if (!failed.has(name)) failed.set(name, `${form}: ${error}`);
    }
  }

  const unexpected = [...failed].filter(([name]) => !(name in KNOWN_FAILURES)).map(([name, why]) => `${name} (${why})`);
  expect(unexpected, 'exports Mermaid refuses').toEqual([]);
  const nowDrawing = Object.keys(KNOWN_FAILURES).filter((name) => !failed.has(name));
  expect(nowDrawing, 'these draw now: take them off KNOWN_FAILURES').toEqual([]);
  expect(drawn).toBeGreaterThan(200);
});
