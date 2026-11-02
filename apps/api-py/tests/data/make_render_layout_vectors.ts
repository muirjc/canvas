/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates render_layout_vectors.json: what the TypeScript diagram-core's computeSequenceLayout,
// computeLegendEntries and legendLayout return, for tests/test_diagram_core_render_layout.py. The models are
// included (parsed here by TypeScript), so the Python test needs no parser. Runs inside diagram-core's vitest:
// copy it to packages/diagram-core/tests/zz-tmp-render.test.ts, then from packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/render_layout_vectors.json npx vitest run tests/zz-tmp-render.test.ts
// and delete the copy (and restore .vitest/, which every vitest run rewrites).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { detectDslFamily } from '../src/dsl/detect.js';
import { getDslFamily } from '../src/dsl/registry.js';
import { parseSequence } from '../src/dsl/sequence.js';
import { isParseSuccess } from '../src/dsl/types.js';
import { computeLegendEntries, legendLayout } from '../src/render/legend.js';
import { computeSequenceLayout } from '../src/render/sequence-layout.js';

const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
// A Map as [id, value] pairs: keeps insertion order (Object.fromEntries would move integer-like keys first).
const entries = (m: Map<string, unknown>) => [...m.entries()];
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

it('gen', () => {
  // --- sequence layouts -------------------------------------------------------------------------------------
  const seqModels: { name: string; model: any }[] = [];
  const parse = (name: string, dsl: string) => {
    const r = parseSequence(dsl);
    if (!isParseSuccess(r)) throw new Error(`${name}: ${JSON.stringify(r)}`);
    seqModels.push({ name, model: json(r.model) });
  };
  for (const c of readdirSync(join(CORPUS, 'cases')).sort()) {
    if (!c.startsWith('sequence-')) continue;
    parse(c, readFileSync(join(CORPUS, 'cases', c, 'input.mmd'), 'utf8'));
  }
  parse('empty-header', 'sequenceDiagram\n');
  parse('self-messages', 'sequenceDiagram\n  A->>A: me\n  A->>B: hi\n  B-->>B: loop back\n  B->>B: again\n');
  parse(
    'nested-activations',
    'sequenceDiagram\n  A->>+B: one\n  B->>+B: two\n  B->>+C: three\n  activate B\n  C-->>-B: back\n  B-->>-A: done\n  deactivate B\n  deactivate B\n  deactivate C\n  activate A\n  activate A\n',
  );
  parse('deactivate-first', 'sequenceDiagram\n  participant A\n  participant B\n  deactivate B\n  activate A\n  activate B\n  A->>B: x\n');
  parse(
    'notes-many',
    'sequenceDiagram\n  participant A\n  participant B\n  participant C\n  Note left of B: left of b\n  Note right of C: right of c\n  Note over A,C: span\n  Note over C,A: reversed span\n  Note over B: just b\n  Note left of A: x\n  Note right of Z: new z\n',
  );
  parse(
    'boxes',
    'sequenceDiagram\n  box Aqua Front\n    participant A\n    participant B\n  end\n  box Back end\n    participant C\n  end\n  box Empty\n  end\n  participant D\n  A->>D: x\n',
  );
  parse(
    'blocks-dividers',
    'sequenceDiagram\n  participant A\n  participant B\n  participant C\n  alt ok\n    A->>B: yes\n  else bad\n    B->>C: no\n  else worse\n    Note over C: n\n  end\n  par one\n    A->>C: p\n  and two\n    C->>A: q\n  end\n  critical c\n    A->>B: r\n  option o\n    activate C\n    deactivate C\n  end\n  loop empty\n  end\n  rect rgb(1,2,3)\n    opt inner\n      loop deeper\n        B->>C: deep\n      end\n    end\n  end\n  break stop\n    A->>A: self\n  end\n',
  );
  parse(
    'create-destroy',
    'sequenceDiagram\n  participant A\n  A->>B: hello\n  create participant C as Carl\n  A->>C: hi\n  destroy C\n  C-->>A: bye\n  create actor D\n  D->>A: x\n',
  );
  parse(
    'unicode-long',
    'sequenceDiagram\n  participant E as Émile 🎨\n  participant J as 日本語のラベル\n  E->>J: 🎨 emoji 𝔘 message\n  Note over E,J: a very long note that goes on and on and on and on and on and on to hit the maximum note width\n  participant L as An extremely long participant label that keeps going and going and going\n  L->>E: a message label that is also quite long, much longer than the column itself would be\n',
  );
  parse('autonumber-many', `sequenceDiagram\n  autonumber 10 5\n${Array.from({ length: 30 }, (_, i) => `  P${i % 7}->>P${(i * 3) % 7}: m${i}\n`).join('')}`);
  // Hand-made models the parser can't produce.
  const raw = (name: string, model: any) => seqModels.push({ name, model: { diagramTypeId: 'sequence', nodes: [], edges: [], containers: [], ...model } });
  raw('empty-model', {});
  raw('edges-only', { edges: [{ id: 'e1', sourceId: 'x', targetId: 'y', label: '' }, { id: 'e2', sourceId: 'x', targetId: 'x', sequenceOrder: 3 }] });
  raw('containers-only', { containers: [{ id: 'c1', label: 'L', role: 'loop', sequenceOrder: 2 }, { id: 'n1', label: 'n', role: 'note-over', size: { width: 33, height: 20 } }] });
  raw('sized-headers', {
    nodes: [
      { id: '10', label: 'ten', shape: 'rectangle', size: { width: 77.5, height: 33.25 } },
      { id: 'b', label: 'b', shape: 'person', size: { width: 201, height: 99 } },
      { id: '2', label: 'two', shape: 'rectangle' },
      { id: 'boxed', label: 'boxed', shape: 'rectangle', containerId: 'bx' },
    ],
    edges: [
      { id: 'm1', sourceId: '10', targetId: 'b', label: 'x', sequenceOrder: 0.5, containerId: 'blk' },
      { id: 'm2', sourceId: '2', targetId: 'ghost', label: 'y', sequenceOrder: 7, containerId: 'div' },
      { id: '1', sourceId: 'b', targetId: 'b', label: 'z' },
    ],
    containers: [
      { id: 'bx', label: 'box', role: 'box' },
      { id: 'blk', label: 'alt', role: 'alt', sequenceOrder: 0 },
      { id: 'div', label: 'else', role: 'else', parentContainerId: 'blk', sequenceOrder: 4 },
      { id: 'ghostblock', label: 'loop', role: 'loop', sequenceOrder: 9, attachedNodeIds: ['nobody'] },
      { id: 'act', label: '', role: 'activate', attachedNodeIds: ['b'], sequenceOrder: 1 },
      { id: 'act2', label: '', role: 'activate', attachedNodeIds: [], sequenceOrder: 1 },
      { id: 'act3', label: '', role: 'activate', attachedNodeIds: ['ghost'], sequenceOrder: 2 },
      { id: 'deact', label: '', role: 'deactivate', attachedNodeIds: ['ghost'], sequenceOrder: 3 },
      { id: 'nl', label: 'n', role: 'note-left', attachedNodeIds: ['ghost', 'b'], sequenceOrder: 5, size: { width: 120.5, height: 40 } },
      { id: 'nr', label: 'n', role: 'note-right', sequenceOrder: 6 },
      { id: 'no', label: 'n', role: 'note-over', attachedNodeIds: ['2', '10'], sequenceOrder: 6, size: { width: 61, height: 40 } },
    ],
  });
  const sequence = seqModels.map(({ name, model }) => {
    const l = computeSequenceLayout(model);
    return {
      name,
      model,
      layout: {
        lifelines: entries(l.lifelines),
        messages: entries(l.messages),
        activations: entries(l.activations),
        blocks: entries(l.blocks),
        notes: entries(l.notes),
        boxes: entries(l.boxes),
        diagramWidth: l.diagramWidth,
        diagramHeight: l.diagramHeight,
      },
    };
  });

  // --- legends ----------------------------------------------------------------------------------------------
  const standards: Record<string, any> = Object.fromEntries(
    readdirSync(join(CORPUS, 'standards'))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(CORPUS, 'standards', f), 'utf8'))]),
  );
  const base = { allowedShapeIds: [], mandatoryShapeIds: [], allowedIconLibraryRefs: [], colorPalette: [] };
  standards['hand-no-kinds'] = { ...base };
  standards['hand-swatches'] = {
    ...base,
    elementKinds: [
      { id: 'svc', label: 'Service 🎨', shapes: ['rectangle'], approvedFills: ['#111111', '#222222'], approvedStrokes: ['#333333'] },
      { id: 'db', label: 'Database', shapes: ['cylinder'], approvedFills: [], match: { role: 'store' } },
      { id: 'ext', label: 'External', shapes: [], approvedFills: [''], approvedStrokes: [], match: { role: 'svc', external: true } },
      { id: 'unused', label: 'Unused', shapes: [], approvedFills: ['#999999'] },
    ],
    connectorRules: [
      { id: 'any', label: 'Anything', from: '*', to: '*' },
      { id: 'svc-db', label: 'Reads', from: 'svc', to: 'db', lineStyles: ['dotted'], arrows: ['both'], approvedStrokes: ['#444444'] },
      { id: 'to-svc', label: 'Calls', from: '*', to: 'svc', lineStyles: [], arrows: [] },
      { id: 'never', label: 'Never', from: 'db', to: 'db' },
    ],
  };
  // Each model is paired with no rules, the two hand-made ones, and the standards its case names (all of them
  // when it names none), which is what makes entries appear.
  const models: { name: string; model: any; rules: string[] }[] = [];
  for (const c of readdirSync(join(CORPUS, 'cases')).sort()) {
    if (c.startsWith('error-')) continue;
    const input = readFileSync(join(CORPUS, 'cases', c, 'input.mmd'), 'utf8');
    const familyId = detectDslFamily(input);
    if (!familyId) continue;
    const parsed = getDslFamily(familyId)!.parse(input);
    if (!isParseSuccess(parsed)) continue;
    const meta = existsSync(join(CORPUS, 'cases', c, 'case.json')) ? JSON.parse(readFileSync(join(CORPUS, 'cases', c, 'case.json'), 'utf8')) : {};
    if (!meta.standards && !c.includes('legend') && !c.endsWith('-basic') && c !== 'sequence-messages') continue;
    models.push({ name: c, model: json(parsed.model), rules: meta.standards ?? Object.keys(standards).filter((k) => !k.startsWith('hand-')) });
  }
  const hand = (name: string, model: any) => models.push({ name, model: { diagramTypeId: 'flowchart', nodes: [], edges: [], containers: [], ...model }, rules: Object.keys(standards).filter((k) => !k.startsWith('hand-')) });
  hand('hand-empty', {});
  hand('hand-kinds', {
    nodes: [
      { id: 'a', label: 'A', shape: 'rectangle', role: 'svc' },
      { id: 'b', label: 'B', shape: 'cylinder', role: 'store', style: { fillColor: '#abcdef', strokeColor: '' } },
      { id: 'c', label: 'C', shape: 'hexagon', role: 'svc', external: true, style: { strokeColor: '#010101' } },
      { id: 'd', label: 'D', role: 'svc', tags: ['ext'] },
      { id: 'e', label: 'E', shape: 'circle' },
      { id: 'f', label: 'F', shape: 'rectangle', role: 'svc', style: { fillColor: '#fefefe' } },
    ],
    edges: [
      { id: 'e1', sourceId: 'e', targetId: 'e', label: '' },
      { id: 'e2', sourceId: 'a', targetId: 'b', label: '', style: { strokeColor: '#999' } },
      { id: 'e3', sourceId: 'f', targetId: 'b', label: '', lineStyle: 'thick', arrow: 'none' },
      { id: 'e4', sourceId: 'e', targetId: 'a', label: '' },
    ],
  });
  hand('hand-sequence-type', { diagramTypeId: 'sequence', nodes: [{ id: 'a', label: 'A', shape: 'rectangle', role: 'svc' }] });

  const legendVariants: (any | null)[] = [
    null,
    { visible: true },
    { visible: false, title: 'Hidden' },
    { visible: true, title: '  Key  ', position: { x: 5.5, y: -7 } },
    { visible: true, title: '  \t ' },
    { visible: true, title: 'A legend title with 🎨 emoji 𝔘 that is quite long indeed', position: { x: 0 } },
    {
      visible: true,
      title: 'Key',
      hidden: ['kind:svc', 'connector:any', 'kind:primary_activity', 'connector:nope'],
      labels: { 'kind:db': 'Store (renamed)', 'connector:svc-db': '', 'kind:person': 'Human 👤', 'connector:any': 'Hidden anyway' },
      extra: [
        { id: 'x1', label: 'Extra shape', sample: { kind: 'shape', shape: 'diamond', fill: '#ffffff' } },
        { id: 'x2', label: '', sample: { kind: 'line', arrow: 'both', lineStyle: 'dotted' } },
      ],
    },
  ];
  const boundsList = [
    { width: 800, height: 600 },
    { width: 0, height: 0 },
    { width: 16.75, height: 3 },
    { width: 1e9, height: 1e9 },
  ];
  const legend: any[] = [];
  for (let m = 0; m < models.length; m++) {
    for (let v = 0; v < legendVariants.length; v++) {
      const variant = legendVariants[v];
      const model = variant === null ? models[m].model : { ...models[m].model, legend: variant };
      for (const rulesName of [null, 'hand-no-kinds', 'hand-swatches', ...models[m].rules]) {
        const computed = computeLegendEntries(model, rulesName === null ? undefined : standards[rulesName]);
        legend.push({
          model: m,
          variant: v,
          rules: rulesName,
          entries: json(computed),
          // One per boundsList entry; null when every one is null (no visible legend), to keep the file small.
          layouts: (() => {
            // Each row's `entry` is entries[i] itself: written as its index here, to keep the file small.
            const all = boundsList.map((b) => {
              const layout = legendLayout(model, computed, b);
              if (layout === null) return null;
              layout.rows.forEach((row, i) => {
                if (row.entry !== computed[i]) throw new Error('row entry is not entries[i]');
              });
              return json({ ...layout, rows: layout.rows.map((row, i) => ({ ...row, entry: i })) });
            });
            return all.every((l) => l === null) ? null : all;
          })(),
        });
      }
    }
  }
  writeFileSync(process.env.OUT!, JSON.stringify({ sequence, legendModels: models, legendVariants, standards, boundsList, legend }));
});
