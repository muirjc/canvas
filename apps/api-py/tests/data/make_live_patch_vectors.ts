/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates live_patch_vectors.json (canvas-vvi) for tests/test_live_patch.py: seeded random edits to corpus
// diagrams and the patches diffModels makes of them. Python must apply every patch and get TypeScript's JSON
// text, key order included: a hash of JSON.stringify of the model after each patch, the whole model at the end.
// It imports diagram-core's source, so it runs inside that package's vitest: copy it to
// packages/diagram-core/tests/zz-tmp-live.test.ts, then from packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/live_patch_vectors.json npx vitest run tests/zz-tmp-live.test.ts
// and delete the copy (and restore .vitest/json/output.json, which every vitest run rewrites).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { detectDslFamily } from '../src/dsl/detect.js';
import { getDslFamily } from '../src/dsl/registry.js';
import { isParseSuccess } from '../src/dsl/types.js';
import { applyPatch, diffModels } from '../src/live/model-patch.js';
import { prng, randomEdit } from './contract/live-random-edits.js';

const CORPUS = fileURLToPath(new URL('../corpus/cases/', import.meta.url));
const json = (v: unknown): any => JSON.parse(JSON.stringify(v));
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

it('writes the live patch vectors', () => {
  const random = prng(2026);
  const cases: any[] = [];
  for (const name of readdirSync(CORPUS).sort()) {
    const dsl = readFileSync(join(CORPUS, name, 'input.mmd'), 'utf8');
    if (dsl.length > 1500) continue;
    const family = detectDslFamily(dsl);
    const parsed = family ? getDslFamily(family)?.parse(dsl) : undefined;
    if (!parsed || !isParseSuccess(parsed)) continue;
    for (let run = 0; run < 2; run++) {
      const start = json(parsed.model);
      let model = start;
      const steps: any[] = [];
      for (let step = 0; step < 10; step++) {
        const next = json(randomEdit(model, random));
        const patch = diffModels(model, next);
        if (!patch) continue;
        model = json(applyPatch(model, json(patch)));
        steps.push({ patch: json(patch), digest: digest(model) });
      }
      cases.push({ name: `${name}#${run}`, start, steps, end: model });
    }
  }
  writeFileSync(process.env.OUT!, JSON.stringify({ cases }) + '\n');
});
