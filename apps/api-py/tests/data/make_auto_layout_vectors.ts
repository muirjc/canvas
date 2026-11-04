/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates auto_layout_vectors.json (canvas-p2g8.2; C4 side hints canvas-rqm6): what the TypeScript diagram-core's autoLayout returns, and
// what dagre.layout (with Auto Layout's options) returns on its own, for tests/test_diagram_core_auto_layout.py.
// - "models": every golden-corpus case that parses, with every direction its family offers, plus seeded random
//   models (DAGs and cycles, isolated nodes, duplicate and self edges, edges to unknown ids, groups nested several
//   deep with their own direction, loops of groups, empty groups, odd ids, unusual sizes, every family);
// - "dagre": seeded random flat graphs straight through dagre.layout, node x/y recorded.
// It imports diagram-core's source, so it runs inside that package's vitest: copy it to
// packages/diagram-core/tests/zz-tmp-auto-layout.test.ts, then from packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/auto_layout_vectors.json npx vitest run tests/zz-tmp-auto-layout.test.ts
// and delete the copy (and restore .vitest/json/output.json, which every vitest run rewrites).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dagre from '@dagrejs/dagre';
import { it } from 'vitest';
import { detectDslFamily } from '../src/dsl/detect.js';
import { getDslFamily } from '../src/dsl/registry.js';
import { isParseSuccess } from '../src/dsl/types.js';
import { autoLayout, autoLayoutUsesDirection } from '../src/model/auto-layout.js';

const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
// A parsed model as JSON, without its null fields: Python reads None as undefined.
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

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What Auto Layout changes: the direction, node positions, group positions and sizes. */
const projection = (m: any) => ({
  direction: m.direction ?? null,
  nodes: m.nodes.map((n: any) => [n.id, n.position ?? null]),
  containers: m.containers.map((c: any) => [c.id, c.position ?? null, c.size ?? null]),
});

const DIRECTIONS = [undefined, 'TD', 'LR', 'BT', 'RL'] as const;

it('gen', () => {
  const models: any[] = [];
  const add = (name: string, model: any, family: string, direction: string | undefined) => {
    const input = withoutNulls(JSON.parse(JSON.stringify(model)));
    const out = autoLayout(input, direction as any, family);
    models.push({ name, family, direction: direction ?? null, model: input, expected: projection(out) });
  };

  for (const c of readdirSync(join(CORPUS, 'cases')).sort()) {
    const dsl = readFileSync(join(CORPUS, 'cases', c, 'input.mmd'), 'utf8');
    const family = detectDslFamily(dsl);
    const parsed = family ? getDslFamily(family)?.parse(dsl) : undefined;
    if (!family || !parsed || !isParseSuccess(parsed)) continue;
    for (const direction of autoLayoutUsesDirection(family) ? DIRECTIONS : [undefined]) add(c, parsed.model, family, direction);
  }

  // Hand-made: things random models rarely hit.
  const box = (id: string, containerId?: string) => ({ id, label: id, shape: 'rectangle', position: { x: 0, y: 0 }, ...(containerId ? { containerId } : {}) });
  const link = (sourceId: string, targetId: string, i: number) => ({ id: `h${i}`, sourceId, targetId });
  const handMade: [string, any][] = [
    // `${from}->${to}` collides: "a->b" -> "c" and "a" -> "b->c" are one key, so the second edge is dropped.
    ['hand-dedup-text-collision', { nodes: ['a->b', 'c', 'a', 'b->c', 'x'].map((i) => box(i)), edges: [link('a->b', 'c', 1), link('a', 'b->c', 2), link('x', 'a', 3)] }],
    // Two-cycles (an edge and its opposite) and parallel edges: dagre's reversed-pair ordering.
    ['hand-two-cycles', { nodes: ['p', 'q', 'r', 's', 't'].map((i) => box(i)), edges: [link('p', 'q', 1), link('q', 'p', 2), link('p', 'r', 3), link('r', 'p', 4), link('q', 's', 5), link('s', 't', 6), link('t', 'q', 7), link('p', 't', 8)] }],
    // Groups four deep, each with its own direction, edges across levels, an empty group.
    ['hand-deep-groups', {
      nodes: [box('a', 'g4'), box('b', 'g4'), box('c', 'g3'), box('d', 'g2'), box('e', 'g1'), box('f')],
      containers: [
        { id: 'g1', label: 'g1', direction: 'LR' },
        { id: 'g2', label: 'g2', parentContainerId: 'g1', direction: 'BT' },
        { id: 'g3', label: 'g3', parentContainerId: 'g2', direction: 'RL' },
        { id: 'g4', label: 'g4', parentContainerId: 'g3' },
        { id: 'empty', label: 'empty', parentContainerId: 'g2' },
      ],
      edges: [link('a', 'b', 1), link('b', 'c', 2), link('c', 'd', 3), link('d', 'e', 4), link('e', 'f', 5), link('f', 'a', 6), link('a', 'empty', 7)],
    }],
    // canvas-rqm6: side hints. A chain of rows, a contradiction, a hint against a plain edge, Lay_* only.
    ['hand-hints-rows', {
      nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((i) => box(i)),
      edges: [
        { ...link('a', 'b', 1), layoutHint: 'right' },
        { ...link('b', 'c', 2), layoutHint: 'right' },
        { ...link('d', 'a', 3), layoutHint: 'left' },
        { ...link('c', 'a', 4), layoutHint: 'right' },
        { ...link('a', 'e', 5), layoutHint: 'up' },
        link('e', 'f', 6),
      ],
      layoutHints: [{ from: 'f', to: 'b', direction: 'down' }, { from: 'f', to: 'e', direction: 'left' }, { from: 'x', to: 'a', direction: 'up' }],
    }],
    // Hints across groups place the groups; a hint inside a group with its own direction.
    ['hand-hints-groups', {
      nodes: [box('a', 'g1'), box('b', 'g1'), box('c', 'g2'), box('d')],
      containers: [{ id: 'g1', label: 'g1', direction: 'LR' }, { id: 'g2', label: 'g2' }],
      edges: [{ ...link('a', 'b', 1), layoutHint: 'down' }, { ...link('b', 'c', 2), layoutHint: 'left' }, { ...link('d', 'c', 3), layoutHint: 'up' }],
      layoutHints: [{ from: 'g1', to: 'd', direction: 'right' }],
    }],
  ];
  for (const [name, partial] of handMade) {
    for (const direction of DIRECTIONS) add(name, { diagramTypeId: 'flowchart', containers: [], ...partial }, 'flowchart', direction);
  }

  const rand = prng(20261104);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)];
  const chance = (p: number) => rand() < p;
  const ODD_IDS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', '0', '10', '1e3', 'a->b', 'b', 'a', 'x y', 'Ünï', '\u{1D4B3}', 'z', '-1'];
  const id = (prefix: string, i: number) => (chance(0.3) ? pick(ODD_IDS) : `${prefix}${i}`);
  const SHAPES = ['rectangle', 'rounded-rectangle', 'diamond', 'circle', 'cylinder', 'stadium', 'icon', 'person', 'hexagon'];
  const LABELS = ['A', '', 'Two words', 'A label long enough to wrap over several lines of text', 'a<br/>b<br/>c'];
  const SIZES = [{ width: 0, height: 0 }, { width: 1, height: 500 }, { width: 2.5, height: 13.7 }, { width: 1000, height: 3 }, { width: 140, height: 60 }];
  const FAMILIES = ['flowchart', 'flowchart', 'c4', 'erd', 'uml', 'architecture', 'sequence'];
  const HINTS = ['up', 'down', 'left', 'right', 'up', 'down', 'left', 'right', 'sideways', 'constructor'];
  const GROUP_DIRECTIONS = [undefined, undefined, 'TD', 'TB', 'LR', 'BT', 'RL', 'XX'];

  for (let k = 0; k < 400; k++) {
    const nodeIds = [...new Set(Array.from({ length: int(16) }, (_, i) => id('n', i)))];
    const groupIds = [...new Set(Array.from({ length: chance(0.4) ? 0 : int(6) }, (_, i) => id('g', i)))];
    const containers = groupIds.map((gid) => {
      const c: any = { id: gid, label: gid };
      if (chance(0.6) && groupIds.length) c.parentContainerId = chance(0.9) ? pick(groupIds) : 'nowhere';
      const direction = pick(GROUP_DIRECTIONS);
      if (direction) c.direction = direction;
      if (chance(0.3)) c.size = pick(SIZES);
      if (chance(0.5)) c.position = { x: int(500), y: int(500) };
      return c;
    });
    const nodes = nodeIds.map((nid) => {
      const n: any = { id: nid, label: pick(LABELS), shape: pick(SHAPES), position: { x: int(300), y: int(300) } };
      if (groupIds.length && chance(0.6)) n.containerId = chance(0.9) ? pick(groupIds) : 'nowhere';
      if (chance(0.15)) n.size = pick(SIZES);
      if (chance(0.1)) n.attributes = [{ type: 'string', name: 'id', keys: ['PK'] }, { type: 'int', name: 'count', keys: [] }];
      if (chance(0.1)) n.description = 'Some description of this element';
      return n;
    });
    const ends = [...nodeIds, ...nodeIds, ...groupIds, 'ghost', 'ghost2', ''];
    const cyclic = chance(0.5);
    const edges: any[] = [];
    const edgeCount = int(nodeIds.length * 2 + 2);
    for (let i = 0; i < edgeCount; i++) {
      let s = pick(ends);
      let t = pick(ends);
      // A DAG: edges only go forward in declaration order (unless this model may have cycles).
      if (!cyclic && nodeIds.includes(s) && nodeIds.includes(t) && nodeIds.indexOf(s) > nodeIds.indexOf(t)) [s, t] = [t, s];
      edges.push({
        id: `e${i}`,
        sourceId: s,
        targetId: t,
        ...(chance(0.2) ? { sourceAnchor: pick(['T', 'B', 'L', 'R']) } : {}),
        // canvas-rqm6: side hints (and a few values that aren't sides).
        ...(chance(0.3) ? { layoutHint: pick(HINTS) } : {}),
      });
      if (chance(0.1)) edges.push({ id: `d${i}`, sourceId: s, targetId: t });
    }
    const family = pick(FAMILIES);
    const model: any = { diagramTypeId: family, nodes, edges, containers };
    if (chance(0.3)) {
      model.layoutHints = Array.from({ length: 1 + int(4) }, () => ({ from: pick(ends), to: pick(ends), direction: pick(HINTS) }));
    }
    if (chance(0.3)) model.direction = pick(['TD', 'LR', 'BT', 'RL', 'TB']);
    add(`random-${k}`, model, family, pick(DIRECTIONS));
  }

  // dagre on its own, with Auto Layout's options.
  const graphs: any[] = [];
  const dagreRand = prng(4111);
  const dInt = (n: number) => Math.floor(dagreRand() * n);
  const dPick = <T>(items: readonly T[]): T => items[dInt(items.length)];
  for (let k = 0; k < 300; k++) {
    const count = 1 + dInt(k < 280 ? 20 : 60);
    const nodes = Array.from({ length: count }, (_, i) => [
      dagreRand() < 0.2 ? `#${dPick(ODD_IDS)}${i}` : `#n${i}`,
      dPick([0, 10, 140, 200, 33.3, 61.6]),
      dPick([0, 20, 60, 76.8, 105.25]),
    ]);
    const edges: [string, string][] = [];
    const edgeCount = dInt(count * 2 + 1);
    const cyclic = dagreRand() < 0.5;
    for (let i = 0; i < edgeCount; i++) {
      let a = dInt(count);
      let b = dInt(count);
      if (a === b) continue;
      if (!cyclic && a > b) [a, b] = [b, a];
      edges.push([nodes[a][0] as string, nodes[b][0] as string]);
    }
    const graph = {
      rankdir: dPick(['TB', 'BT', 'LR', 'RL']),
      nodesep: dPick([50, 0, 10, 33.3]),
      // Not 0: with no rank gap a dummy can sit on its node's centre and dagre's edge clipping throws.
      ranksep: dPick([60, 1, 20, 17.5]),
      marginx: 0,
      marginy: 0,
    };
    const g = new dagre.graphlib.Graph();
    g.setGraph({ ...graph });
    g.setDefaultEdgeLabel(() => ({}));
    for (const [v, width, height] of nodes) g.setNode(v as string, { width, height });
    for (const [v, w] of edges) g.setEdge(v, w);
    dagre.layout(g, { useDynamic: false });
    graphs.push({ graph, nodes, edges, expected: nodes.map(([v]) => [g.node(v as string).x, g.node(v as string).y]) });
  }

  writeFileSync(process.env.OUT!, JSON.stringify({ models, dagre: graphs }) + '\n');
});
