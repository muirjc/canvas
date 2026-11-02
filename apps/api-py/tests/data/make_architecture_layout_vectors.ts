/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates architecture_layout_vectors.json: what the TypeScript diagram-core's computeArchitectureLayout returns,
// for tests/test_diagram_core_architecture.py. Runs inside diagram-core's vitest like make_layout_vectors.ts: copy
// it to packages/diagram-core/tests/zz-tmp-arch.test.ts, then from packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/architecture_layout_vectors.json npx vitest run tests/zz-tmp-arch.test.ts
// and delete the copy (and restore .vitest/json/output.json, which every vitest run rewrites).
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { computeArchitectureLayout } from '../src/model/architecture-layout.js';

const svc = (id: string, containerId?: string, label = id.toUpperCase()) => ({ id, label, shape: 'icon', ...(containerId ? { containerId } : {}) });
const junction = (id: string, containerId?: string) => ({ id, label: '', shape: 'circle', role: 'junction', ...(containerId ? { containerId } : {}) });
const group = (id: string, parentContainerId?: string) => ({ id, label: id, ...(parentContainerId ? { parentContainerId } : {}) });
const edge = (sourceId: string, targetId: string, extra: Record<string, unknown> = {}) => ({ id: `${sourceId}-${targetId}`, sourceId, targetId, ...extra });

it('gen', () => {
  const cases: any[] = [
    { nodes: [], containers: [], edges: [], alignments: [] },
    { nodes: [svc('a'), svc('b')], containers: [], edges: [edge('a', 'b')], alignments: [] },
    {
      nodes: ['c', 'n', 's', 'e', 'w'].map((i) => svc(i)),
      containers: [],
      edges: [edge('c', 'n', { sourceAnchor: 'T', targetAnchor: 'B' }), edge('c', 's', { sourceAnchor: 'B' }), edge('e', 'c', { targetAnchor: 'R' }), edge('w', 'c', { sourceAnchor: 'R', targetAnchor: 'L' })],
      alignments: [],
    },
    {
      nodes: [svc('a', 'inner'), svc('b', 'inner'), svc('c', 'mid'), svc('d', 'outer'), svc('top')],
      containers: [group('outer'), group('mid', 'outer'), group('inner', 'mid'), group('empty', 'outer')],
      edges: [edge('a', 'b', { sourceAnchor: 'R' }), edge('c', 'a', { sourceAnchor: 'B', targetAnchor: 'T' }), edge('d', 'c', { sourceAnchor: 'L', sourceIsGroup: true, targetIsGroup: true }), edge('top', 'd')],
      alignments: [],
    },
    {
      nodes: [svc('l'), svc('r'), svc('u'), svc('d'), junction('hub'), junction('j2', 'net'), svc('in', 'net')],
      containers: [group('net')],
      edges: [edge('l', 'hub', { sourceAnchor: 'R', targetAnchor: 'L' }), edge('hub', 'r', { sourceAnchor: 'R' }), edge('hub', 'u', { sourceAnchor: 'T' }), edge('hub', 'd', { sourceAnchor: 'B' }), edge('j2', 'in', { sourceAnchor: 'R' }), edge('d', 'j2', { sourceAnchor: 'B' })],
      alignments: [],
    },
    {
      nodes: [svc('a'), svc('b'), svc('c'), svc('d'), svc('e', 'g'), svc('f', 'g')],
      containers: [group('g')],
      edges: [],
      alignments: [{ axis: 'row', ids: ['a', 'b', 'c'] }, { axis: 'column', ids: ['a', 'd'] }, { axis: 'column', ids: ['e', 'f'] }, { axis: 'row', ids: ['a', 'e'] }, { axis: 'row', ids: ['nothere', 'a'] }],
    },
    {
      nodes: [...Array.from({ length: 9 }, (_, i) => svc(`s${i}`, undefined, i === 6 ? 'A label long enough to wrap over lines of text' : `S${i}`)), svc('in1', 'g1'), svc('in2', 'g2')],
      containers: [group('g1'), group('g2'), group('g3')],
      edges: [edge('s0', 's1'), edge('s1', 's2'), edge('s2', 's3'), edge('s4', 's5', { sourceAnchor: 'B' }), edge('in1', 'in2')],
      alignments: [],
    },
    // Collisions: two things anchored onto the same side, contradictory hints, self edges, unknown ids.
    {
      nodes: ['a', 'b', 'c', 'd'].map((i) => svc(i)),
      containers: [],
      edges: [edge('a', 'b', { sourceAnchor: 'R' }), edge('a', 'c', { sourceAnchor: 'R' }), edge('a', 'd', { sourceAnchor: 'R' }), edge('b', 'a', { sourceAnchor: 'R' }), edge('a', 'a'), edge('a', 'zz'), edge('c', 'd', { targetAnchor: 'T' })],
      alignments: [{ axis: 'column', ids: ['b', 'c'] }],
    },
    // Unknown parent, a loop of groups, a group nested in itself.
    {
      nodes: [svc('a', 'nope'), svc('b', 'x'), svc('c', 'y'), svc('d', 'self')],
      containers: [group('x', 'y'), group('y', 'x'), group('self', 'self'), group('z', 'x')],
      edges: [edge('a', 'b'), edge('b', 'c', { targetAnchor: 'B' })],
      alignments: [],
    },
    // Cross-group edges lifting to sibling groups, and node sizes that differ (centering in cells).
    {
      nodes: [svc('a', 'g1', 'A'), svc('b', 'g2', 'A much longer service label for size'), svc('c', 'g2'), { id: 'p', label: 'Person', shape: 'person' }],
      containers: [group('g1'), group('g2'), group('g3', 'g2')],
      edges: [edge('a', 'b', { sourceAnchor: 'B', targetAnchor: 'T' }), edge('c', 'p', { targetAnchor: 'L' }), edge('a', 'c', { sourceIsGroup: true })],
      alignments: [{ axis: 'row', ids: ['g1', 'p'] }],
    },
  ];
  const out = cases.map((c) => {
    const r = computeArchitectureLayout(c.nodes, c.containers, c.edges, c.alignments);
    return { ...c, nodePositions: Object.fromEntries(r.nodePositions), containerPositions: Object.fromEntries(r.containerPositions), containerSizes: Object.fromEntries(r.containerSizes) };
  });
  writeFileSync(process.env.OUT!, JSON.stringify(out));
});
