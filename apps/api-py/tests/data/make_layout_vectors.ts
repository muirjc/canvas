/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates layout_vectors.json: what the TypeScript diagram-core computes for nodeSize, splitLabelLines and
// computeContainmentLayout, for tests/test_diagram_core_layout.py. It imports diagram-core's source, so it runs
// inside that package's vitest: copy it to packages/diagram-core/tests/zz-tmp-gen.test.ts, then from
// packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/layout_vectors.json npx vitest run tests/zz-tmp-gen.test.ts
// and delete the copy (and restore .vitest/json/output.json, which every vitest run rewrites).
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { computeContainmentLayout } from '../src/model/containment-layout.js';
import { nodeSize, splitLabelLines } from '../src/render/svg-renderer.js';

it('gen', () => {
  const nodes: any[] = [
    { id: 'a', label: 'Short', shape: 'rectangle' },
    { id: 'b', label: 'A very long label that needs to wrap over several lines of the node box', shape: 'rectangle' },
    { id: 'c', label: 'one<br/>two<BR>three\nfour', shape: 'rectangle' },
    { id: 'd', label: 'Person', shape: 'person' },
    { id: 'e', label: 'Supercalifragilisticexpialidocious-and-more-and-more-and-more', shape: 'rectangle' },
    { id: 'f', label: 'Styled', shape: 'rectangle', style: { fontSize: 20 } },
    { id: 'g', label: 'Sized', shape: 'rectangle', size: { width: 77, height: 33 } },
    { id: 'h', label: 'Icon', shape: 'icon' },
    { id: 'i', label: 'Icon long caption words here', shape: 'icon', style: { fontSize: 11 } },
    { id: 'j', label: 'emoji \u{1F3A8}\u{1F3A8}\u{1F3A8} wrap me please because I am long enough to wrap around', shape: 'rectangle' },
    { id: 'k', label: 'Entity', shape: 'rectangle', attributes: [{ name: 'id', type: 'int', keys: ['PK'], comment: 'the key' }, { name: 'name', type: 'string', keys: [] }] },
    { id: 'l', label: 'Cls', shape: 'rectangle', umlStereotype: 'interface', members: [{ kind: 'attribute', visibility: '+', name: 'x', type: 'int' }, { kind: 'method', visibility: '-', name: 'run', params: 'a', returnType: 'void' }] },
    { id: 'm', label: 'Described', shape: 'rectangle', role: 'system', description: 'Does many things for many people in the bank', technology: 'Java' },
  ];
  const labels = ['', 'x', 'a b c', 'one<br/>two', 'one<BR />two', 'one<br\t/>two\r\nthree', 'a  b', ' lead trail ', 'word '.repeat(30), 'x'.repeat(100), 'café \u{1F3A8} text '.repeat(10)];
  const out = {
    sizes: nodes.map((n) => [n, nodeSize(n)]),
    lines: labels.flatMap((l) => [[l, null, null, splitLabelLines(l)], [l, 124, 14, splitLabelLines(l, 124, 14)], [l, 40, 20, splitLabelLines(l, 40, 20)]]),
    layouts: [] as any[],
  };
  const cases = [
    { nodes: [{ id: 'a', label: 'A', shape: 'rectangle' }, { id: 'b', label: 'B', shape: 'rectangle' }], containers: [] },
    { nodes: [{ id: 'a', label: 'A', shape: 'rectangle', containerId: 'g1' }, { id: 'b', label: 'B', shape: 'rectangle', containerId: 'g1' }, { id: 'c', label: 'C', shape: 'rectangle' }], containers: [{ id: 'g1', label: 'G1' }] },
    { nodes: [{ id: 'a', label: 'A', shape: 'rectangle', containerId: 'inner' }], containers: [{ id: 'outer', label: 'O' }, { id: 'inner', label: 'I', parentContainerId: 'outer' }, { id: 'empty', label: 'E' }] },
    { nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}`, shape: 'rectangle' })), containers: [] },
    { nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Node ${i} with a longer label for wrapping`, shape: 'rectangle', containerId: i % 2 ? 'g2' : 'g1' })), containers: [{ id: 'g1', label: 'G1' }, { id: 'g2', label: 'G2' }, { id: 'g3', label: 'G3', parentContainerId: 'g1' }] },
    { nodes: [], containers: [] },
  ];
  for (const c of cases) {
    const r = computeContainmentLayout(c.nodes as any, c.containers as any);
    out.layouts.push({ nodes: c.nodes, containers: c.containers, nodePositions: Object.fromEntries(r.nodePositions), containerPositions: Object.fromEntries(r.containerPositions), containerSizes: Object.fromEntries(r.containerSizes) });
  }
  writeFileSync(process.env.OUT!, JSON.stringify(out));
});
