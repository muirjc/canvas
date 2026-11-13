/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// canvas-4h1j.2: regenerates wardley_ops_vectors.json -- seeded random sequences of diagram-core's Wardley map edits
// (model/wardley-ops.ts, plus renames and node removals the editor makes) applied by TypeScript to the Wardley
// corpus diagrams and an empty map: a hash of JSON.stringify of the model after every step, the whole model after a
// sequence's last edit, and the ids each step generated, for tests/test_diagram_core_wardley_ops.py. It imports
// diagram-core's source, so it runs inside that package's vitest: copy it to
// packages/diagram-core/tests/zz-tmp-wardley-ops.test.ts, then from packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/wardley_ops_vectors.json npx vitest run tests/zz-tmp-wardley-ops.test.ts
// and delete the copy.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, vi } from 'vitest';
import { parseWardley } from '../src/dsl/wardley.js';
import { isParseSuccess } from '../src/dsl/types.js';
import { updateNodeLabel } from '../src/model/diagram-ops.js';
import * as ops from '../src/model/wardley-ops.js';

const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const withoutNulls = (v: any): any =>
  Array.isArray(v)
    ? v.map(withoutNulls)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== null)
            .map(([k, x]) => [k, withoutNulls(x)]),
        )
      : v;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it('gen', () => {
  let idCount = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((idCount += 1) + 0.5) / 36 ** 6);
  vi.spyOn(Date, 'now').mockReturnValue(0);

  const rand = prng(20261113);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const chance = (p: number) => rand() < p;
  const coordinate = () => pick([0, 0.05, 0.5, 0.333, 0.999, 1, 1.5, -0.2, 0.125, 0.875]);
  const labels = ['Tea', 'New Component', 'Kettle', 'notebook', 'Ünïcode', 'a "q"', ' ', 'Power'];

  const step = (model: any) => {
    const call = (op: string, ...args: any[]) => ({ op, args, run: () => (op === 'updateNodeLabel' ? updateNodeLabel : (ops as any)[op])(model, ...args) });
    const nodeId = () => (model.nodes.length > 0 && chance(0.95) ? pick(model.nodes).id : 'missing');
    const edgeId = () => (model.edges.length > 0 && chance(0.95) ? pick(model.edges).id : 'missing');
    const r = rand();
    if (r < 0.25) {
      const input: any = { kind: chance(0.97) ? pick(ops.WARDLEY_ELEMENT_KINDS) : 'market' };
      if (chance(0.5)) input.label = pick(labels);
      if (chance(0.5)) input.visibility = coordinate();
      if (chance(0.5)) input.evolution = coordinate();
      if (chance(0.2)) input.number = pick([0, 2, 7.6, -1]);
      return call('addWardleyElement', input);
    }
    if (r < 0.5) return call('moveWardleyElement', nodeId(), { visibility: coordinate(), evolution: coordinate() });
    if (r < 0.62) {
      const patch: any = {};
      if (chance(0.5)) patch.strategy = pick([...ops.WARDLEY_STRATEGIES, null]);
      if (chance(0.4)) patch.inertia = chance(0.5);
      if (chance(0.4)) patch.evolve = pick([0.7, 0.123, 1.4, null]);
      return call('setWardleyMarkings', nodeId(), patch);
    }
    if (r < 0.77) {
      const input: any = {};
      if (chance(0.4)) input.label = pick(labels);
      if (chance(0.4)) input.evolution = coordinate();
      return call('addWardleyPipelineComponent', nodeId(), input);
    }
    if (r < 0.87) return call('removeWardleyElement', nodeId());
    if (r < 0.95) return call('setWardleyLinkFlow', edgeId(), pick([...ops.WARDLEY_FLOWS, null]));
    return call('updateNodeLabel', nodeId(), pick(labels.filter((l) => l.trim())));
  };

  const ids = (model: any) => new Set([...model.nodes, ...model.edges, ...model.containers].map((x: any) => x.id));
  const cases: any[] = [];
  const run = (name: string, start: any, sequences: number, length: number) => {
    start = withoutNulls(json(start));
    const out: any = { name, model: start, sequences: [] };
    for (let s = 0; s < sequences; s += 1) {
      let model = json(start);
      const steps: any[] = [];
      for (let i = 0; i < length; i += 1) {
        const { op, args, run: apply } = step(model);
        const before = ids(model);
        const record: any = { op, args: json(args) };
        try {
          model = apply();
          record.ids = [...ids(model)].filter((id) => !before.has(id));
          record.hash = digest(model);
        } catch (error) {
          record.error = (error as Error).message;
        }
        steps.push(record);
        if (record.error) break;
      }
      const last = [...steps].reverse().find((x) => x.hash);
      if (last) last.model = json(model);
      out.sequences.push(steps);
    }
    cases.push(out);
  };

  run('empty', { diagramTypeId: 'wardley', nodes: [], edges: [], containers: [] }, 30, 12);
  for (const c of readdirSync(join(CORPUS, 'cases')).sort()) {
    if (!c.startsWith('wardley-')) continue;
    const parsed = parseWardley(readFileSync(join(CORPUS, 'cases', c, 'input.mmd'), 'utf8'));
    if (!isParseSuccess(parsed)) continue;
    run(c, parsed.model, 12, 10);
  }
  writeFileSync(process.env.OUT!, JSON.stringify({ cases }) + '\n');
});
