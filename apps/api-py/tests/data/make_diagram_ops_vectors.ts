/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates diagram_ops_vectors.json: seeded random sequences of diagram-core's model edits (diagram-ops.ts and
// standard-ops.ts) applied by TypeScript to corpus diagrams and a few hand-made models -- a hash of JSON.stringify of
// the model after every step and the whole model after a sequence's last edit -- for tests/test_diagram_core_ops.py. Each step records the ids TypeScript generated so Python can reuse
// them. It imports diagram-core's source, so it runs inside that package's vitest: copy it to
// packages/diagram-core/tests/zz-tmp-ops.test.ts, then from packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/diagram_ops_vectors.json npx vitest run tests/zz-tmp-ops.test.ts
// and delete the copy (and restore .vitest/json/output.json, which every vitest run rewrites).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, vi } from 'vitest';
import { detectDslFamily } from '../src/dsl/detect.js';
import { getDslFamily } from '../src/dsl/registry.js';
import { isParseSuccess } from '../src/dsl/types.js';
import * as ops from '../src/model/diagram-ops.js';
import * as standardOps from '../src/model/standard-ops.js';

const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
// A parsed model as JSON, without its null fields (NaNs the parser wrote): Python reads None as undefined.
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
const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it('gen', () => {
  // Deterministic ids, so the file only changes when behaviour does.
  const idRandom = prng(7);
  vi.spyOn(Math, 'random').mockImplementation(idRandom);
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

  const rand = prng(20261103);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const chance = (p: number) => rand() < p;
  const maybe = (obj: any, key: string, values: readonly unknown[], p = 0.5) => {
    if (chance(p)) obj[key] = pick(values);
    return obj;
  };

  const standards: any[] = readdirSync(join(CORPUS, 'standards'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CORPUS, 'standards', f), 'utf8')));
  const kinds = standards.flatMap((s) =>
    (s.elementKinds ?? []).map((kind: any) => ({ kind, rules: s })),
  );
  const connectorRules = standards.flatMap((s) => s.connectorRules ?? []);
  // Kinds and rules beyond the corpus: no shapes/swatches, uppercase swatches, empty lists, an `external` match.
  kinds.push(
    { kind: { id: 'bare', label: 'Bare', shapes: [], approvedFills: [] }, rules: undefined },
    {
      kind: {
        id: 'ext',
        label: 'Ext',
        shapes: ['rectangle'],
        approvedFills: ['#AABBCC'],
        approvedStrokes: ['#112233'],
        match: { role: 'system', external: true },
      },
      rules: undefined,
    },
    {
      kind: {
        id: 'nolabel',
        shapes: ['diamond', 'circle'],
        approvedFills: [],
        approvedStrokes: [],
      },
      rules: undefined,
    },
  );
  connectorRules.push(
    { id: 'none', from: '*', to: '*' },
    { id: 'stroke', from: '*', to: '*', approvedStrokes: ['#123456'] },
    { id: 'arrows', from: '*', to: '*', arrows: ['both'], lineStyles: [] },
    { id: 'blank', from: '*', to: '*', arrows: [''], lineStyles: ['dotted'] },
  );

  const labels = ['A', '', 'Two words', 'Ünïcode', 'a<br/>b'];
  const shapes = [
    'rectangle',
    'rounded-rectangle',
    'diamond',
    'circle',
    'cylinder',
    'stadium',
    'icon',
    'person',
  ];
  const colors = ['#ff0000', '#DCFCE7', '#dcfce7', '#92400E', 'red', null];
  const numbers = [0, 1, 2.5, -40, 1000];
  const roles = [
    'person',
    'system',
    'participant',
    'actor',
    'junction',
    'loop',
    'note-over',
    'namespace',
    'box',
    'system-boundary',
  ];
  const stylePatch = () => {
    const patch: any = {};
    maybe(patch, 'fillColor', colors);
    maybe(patch, 'strokeColor', colors);
    maybe(patch, 'strokeWidth', [1, 2.5, null], 0.3);
    maybe(patch, 'strokeDasharray', ['4 2', null], 0.3);
    maybe(patch, 'fontFamily', ['Inter', null], 0.2);
    maybe(patch, 'fontSize', [12, null], 0.2);
    return patch;
  };

  const step = (model: any): { op: string; args: unknown[]; run: () => any } => {
    const nodeId = () => (chance(0.9) && model.nodes.length ? pick(model.nodes).id : 'ghost');
    const edgeId = () => (chance(0.9) && model.edges.length ? pick(model.edges).id : 'ghost');
    const containerId = () =>
      chance(0.9) && model.containers.length ? pick(model.containers).id : 'ghost';
    const call = (fn: string, ...args: unknown[]) => ({
      op: fn,
      args,
      run: () => (ops as any)[fn](model, ...args),
    });
    const callStd = (fn: string, ...args: unknown[]) => ({
      op: fn,
      args,
      run: () => (standardOps as any)[fn](model, ...args),
    });
    switch (Math.floor(rand() * 36)) {
      case 0:
      case 1:
        return call(
          'addNode',
          maybe(maybe({ shape: pick(shapes) }, 'label', labels), 'label', [null], 0.1),
        );
      case 2:
      case 3: {
        const input: any = { sourceId: nodeId(), targetId: nodeId() };
        maybe(input, 'label', labels, 0.3);
        maybe(input, 'arrow', ['none', 'both', 'forward'], 0.3);
        maybe(input, 'erSourceCardinality', ['||', '}o'], 0.2);
        maybe(input, 'erTargetCardinality', ['o{'], 0.2);
        return call('addEdge', input);
      }
      case 4:
        return call('removeNode', nodeId());
      case 5:
        return call('removeEdge', edgeId());
      case 6:
        return call('updateNodeLabel', nodeId(), pick(labels));
      case 7: {
        if (chance(0.3)) return call('setNodeLink', nodeId(), null);
        const link: any = {
          href: pick([
            'https://example.test/a',
            '/docs/x',
            'javascript:alert(1)',
            'https://example.test/"q',
            'mailto:a@b.test',
            '#frag',
            'https://a.test/x\ny',
          ]),
        };
        maybe(link, 'tooltip', ['Open', 'say "hi"', 'two\nlines'], 0.4);
        maybe(link, 'target', ['_blank'], 0.2);
        return call('setNodeLink', nodeId(), link);
      }
      case 8:
        return call('updateEdgeLabel', edgeId(), pick(labels));
      case 9:
        return call('updateNodeStyle', nodeId(), stylePatch());
      case 10:
        return call('updateEdgeStyle', edgeId(), stylePatch());
      case 11:
        return call('updateNodeRole', nodeId(), pick(roles));
      case 12:
        return call(
          'updateEntityAttributes',
          nodeId(),
          pick([
            [],
            [
              { type: 'string', name: 'id', keys: ['PK'] },
              { type: 'int', name: 'n', comment: 'count' },
            ],
          ]),
        );
      case 13:
        return call(
          'updateClassMembers',
          nodeId(),
          pick([
            [],
            [
              { kind: 'attribute', name: 'id', type: 'string', visibility: '-' },
              { kind: 'method', name: 'run', parameters: 'x', returnType: 'void', isStatic: true },
            ],
          ]),
        );
      case 14:
        return call('updateNodeStereotype', nodeId(), pick(['interface', '', 'abstract']));
      case 15: {
        const patch: any = {};
        maybe(patch, 'umlRelationKind', ['inheritance', 'composition', null]);
        maybe(patch, 'sourceCardinality', ['1', '0..*', null]);
        maybe(patch, 'targetCardinality', ['many', null]);
        return call('updateEdgeRelationKind', edgeId(), patch);
      }
      case 16: {
        const patch: any = {};
        maybe(patch, 'erSourceCardinality', ['||', '|o', null]);
        maybe(patch, 'erTargetCardinality', ['o{', null]);
        return call('updateEdgeErCardinality', edgeId(), patch);
      }
      case 17: {
        const patch: any = {};
        maybe(patch, 'arrow', ['none', 'both', 'cross', null]);
        maybe(patch, 'lineStyle', ['dotted', 'thick', null]);
        return call('updateEdgeArrowStyle', edgeId(), patch);
      }
      case 18: {
        const patch: any = {};
        maybe(patch, 'sourceIsGroup', [true, false, null]);
        maybe(patch, 'targetIsGroup', [true, null]);
        maybe(patch, 'sourceAnchor', ['T', 'L', null]);
        maybe(patch, 'targetAnchor', ['B', null]);
        return call('updateEdgeArchitectureModifiers', edgeId(), patch);
      }
      case 19:
        return call(
          'addPointMarkerContainer',
          maybe(
            { role: pick(['activate', 'deactivate']), attachedNodeId: nodeId() },
            'sequenceOrder',
            [0, 3, 99],
            0.3,
          ),
        );
      case 20:
      case 21: {
        const input: any = {};
        maybe(input, 'label', labels, 0.6);
        maybe(
          input,
          'position',
          [
            { x: 10, y: 20 },
            { x: 0.5, y: -3 },
          ],
          0.3,
        );
        maybe(input, 'size', [{ width: 50, height: 60 }], 0.3);
        maybe(input, 'role', roles, 0.4);
        if (chance(0.3)) input.parentContainerId = containerId();
        if (chance(0.2)) input.attachedNodeIds = [nodeId(), nodeId()];
        maybe(input, 'sequenceOrder', [0, 7], 0.2);
        maybe(input, 'style', [{ fillColor: '#eeeeee' }], 0.2);
        return call('addContainer', input);
      }
      case 22:
        return call('setContainerRole', containerId(), pick(roles));
      case 23:
        return call('setContainerDirection', containerId(), pick(['LR', 'TD', undefined]));
      case 24:
        return call('setContainerParent', containerId(), containerId());
      case 25:
        return call('removeContainerParent', containerId());
      case 26:
        return chance(0.5)
          ? call('assignEdgeToContainer', edgeId(), containerId())
          : call('removeEdgeFromContainer', edgeId());
      case 27:
        return call('updateContainerLabel', containerId(), pick(labels));
      case 28:
        return call('moveContainer', containerId(), { x: pick(numbers), y: pick(numbers) });
      case 29:
        return call('resizeContainer', containerId(), {
          width: pick([10, 400.5]),
          height: pick([10, 30]),
        });
      case 30:
        return chance(0.6)
          ? call('assignNodeToContainer', nodeId(), containerId())
          : call('removeNodeFromContainer', nodeId());
      case 31:
        return call('removeContainer', containerId());
      case 32: {
        const patch: any = { enabled: chance(0.6) };
        maybe(patch, 'start', [1, 10]);
        maybe(patch, 'step', [1, 5]);
        return call('setSequenceAutonumber', patch);
      }
      case 33: {
        const { kind, rules } = pick(kinds);
        const opts: any = {};
        maybe(opts, 'label', ['Named', ''], 0.4);
        maybe(opts, 'position', [{ x: 5, y: 6 }], 0.3);
        maybe(opts, 'fallbackShape', ['icon', 'circle'], 0.3);
        if (rules && chance(0.7)) opts.rules = rules;
        return callStd('addElementOfKind', kind, chance(0.15) ? undefined : opts);
      }
      case 34: {
        const { kind, rules } = pick(kinds);
        return callStd('applyElementKind', nodeId(), kind, chance(0.7) ? rules : undefined);
      }
      default:
        return callStd('applyConnectorRule', edgeId(), pick(connectorRules));
    }
  };

  const ids = (model: any) =>
    new Set([...model.nodes, ...model.edges, ...model.containers].map((x: any) => x.id));
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
        const record: any = { op, args: json(args.map((a) => (a === undefined ? null : a))) };
        try {
          const result = apply();
          const next = op === 'addElementOfKind' ? result.model : result;
          if (op === 'addElementOfKind') record.nodeId = result.nodeId;
          record.ids = [...ids(next)].filter((id) => !before.has(id));
          model = next;
          record.hash = digest(model);
        } catch (error) {
          record.error = (error as Error).message;
        }
        steps.push(record);
        if (record.error) break;
      }
      // The whole model once per sequence, so a mismatch can be read, not only detected.
      const last = [...steps].reverse().find((x) => x.hash);
      if (last) last.model = json(model);
      out.sequences.push(steps);
    }
    cases.push(out);
  };

  const empty = (diagramTypeId: string) => ({
    diagramTypeId,
    nodes: [],
    edges: [],
    containers: [],
  });
  run('empty', empty('flowchart'), 12, 10);
  // Nested containers with members, a cycle already in the data, and timeline orders on edges and containers.
  run(
    'nested',
    {
      diagramTypeId: 'flowchart',
      nodes: [
        {
          id: 'a',
          label: 'A',
          shape: 'rectangle',
          position: { x: 10, y: 10 },
          containerId: 'inner',
        },
        {
          id: 'b',
          label: 'B',
          shape: 'diamond',
          position: { x: 50, y: 10 },
          containerId: 'outer',
          style: { fillColor: '#dcfce7', strokeColor: '#166534' },
        },
        { id: 'c', label: 'C', shape: 'circle', position: { x: 90, y: 90 }, tags: ['step', 'x'] },
      ],
      edges: [
        { id: 'e1', sourceId: 'a', targetId: 'b', sequenceOrder: 4, containerId: 'outer' },
        { id: 'e2', sourceId: 'b', targetId: 'c', arrow: 'both', style: { strokeColor: '#000' } },
      ],
      containers: [
        {
          id: 'outer',
          label: 'Outer',
          position: { x: 0, y: 0 },
          size: { width: 200, height: 200 },
        },
        {
          id: 'inner',
          label: 'Inner',
          position: { x: 5, y: 5 },
          size: { width: 80, height: 80 },
          parentContainerId: 'outer',
          sequenceOrder: 9,
        },
        {
          id: 'p',
          label: 'P',
          position: { x: 300, y: 0 },
          size: { width: 10, height: 10 },
          parentContainerId: 'q',
        },
        {
          id: 'q',
          label: 'Q',
          position: { x: 300, y: 50 },
          size: { width: 10, height: 10 },
          parentContainerId: 'p',
        },
      ],
      sequenceAutonumber: { start: 1 },
    },
    20,
    12,
  );
  for (const c of readdirSync(join(CORPUS, 'cases')).sort()) {
    const dsl = readFileSync(join(CORPUS, 'cases', c, 'input.mmd'), 'utf8');
    if (dsl.length > 900) continue;
    const family = detectDslFamily(dsl);
    const parsed = family ? getDslFamily(family)?.parse(dsl) : undefined;
    if (!parsed || !isParseSuccess(parsed)) continue;
    run(c, parsed.model, 3, 8);
  }
  writeFileSync(process.env.OUT!, JSON.stringify({ cases }) + '\n');
});
