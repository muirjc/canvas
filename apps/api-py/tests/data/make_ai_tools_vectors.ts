/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates ai_tools_vectors.json: what the diagram bridge's AI operations (packages/diagram-bridge/src/ai.ts,
// i.e. apps/api/src/ai/diagram-tools.ts and the prompt helpers) answer, for tests/test_diagram_core_ai.py:
//  - tools: every family's tool list (names, descriptions, JSON Schemas) under each rule set, and the primer and
//    standard prompt sections for each;
//  - prompts: the current-diagram prompt section for corpus diagrams, without and with a rule set;
//  - runs: seeded random tool-call sequences (some input deliberately invalid) on corpus diagrams, each step's
//    output, outcomes or error, the ids it generated, and a hash of JSON.stringify of the model after it. The
//    model crosses JSON between calls, as it does in the bridge.
// It needs the bridge's `ai`/`zod`, so it runs inside that package's vitest: copy it to
// packages/diagram-bridge/tests/zz-tmp-ai.test.ts, then from packages/diagram-bridge
//   OUT=<repo>/apps/api-py/tests/data/ai_tools_vectors.json npx vitest run tests/zz-tmp-ai.test.ts
// and delete the copy (and restore .vitest, which every vitest run rewrites).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, vi } from 'vitest';
import { detectDslFamily } from '../../diagram-core/src/dsl/detect.js';
import { getDslFamily } from '../../diagram-core/src/dsl/registry.js';
import { isParseSuccess } from '../../diagram-core/src/dsl/types.js';
import { listTools, promptSections, runTool } from '../src/ai.js';

const CORPUS = fileURLToPath(new URL('../../diagram-core/corpus/', import.meta.url));
const FAMILIES = ['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml'];
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

it('gen', async () => {
  // Low-entropy counter ids (n0000001, ...): deterministic, and nothing a secret scan mistakes for a key.
  let idCount = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((idCount += 1) + 0.5) / 36 ** 6);
  vi.spyOn(Date, 'now').mockReturnValue(0);
  const rand = prng(11032026);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const chance = (p: number) => rand() < p;

  const base = {
    allowedShapeIds: [],
    mandatoryShapeIds: [],
    allowedIconLibraryRefs: [],
    colorPalette: [],
  };
  const rules: any[] = [
    undefined,
    ...readdirSync(join(CORPUS, 'standards'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(CORPUS, 'standards', f), 'utf8'))),
    {
      ...base,
      requireKnownKinds: true,
      elementKinds: [
        {
          id: 'svc',
          label: 'Service',
          shapes: ['rectangle', 'icon'],
          approvedFills: ['#AABBCC', '#ffffff'],
          approvedStrokes: ['#112233'],
          minCount: 2,
          maxCount: 2,
          description: 'A running service',
        },
        {
          id: 'db',
          label: 'Database',
          shapes: ['cylinder'],
          approvedFills: ['#ffffff'],
          maxCount: 1,
          requireConnection: true,
        },
        { id: 'person', label: 'Person', shapes: [], approvedFills: [], match: { role: 'person' } },
      ],
      kindGroups: [
        { id: 'g', label: 'Any', kindIds: ['svc', 'db'], minCount: 1, maxCount: 1 },
        { id: 'h', label: 'Few', kindIds: ['db'], maxCount: 3 },
      ],
      connectorPolicy: 'listed-only',
      connectorRules: [
        {
          id: 'calls',
          label: 'Calls',
          from: 'svc',
          to: 'db',
          requireLabel: true,
          maxPerSource: 2,
          lineStyles: ['dotted'],
          approvedStrokes: ['#123456'],
          arrows: ['both'],
        },
      ],
      containers: { allowed: true, allowedRoles: ['namespace', 'box'] },
      guidance: '  Keep it small.  ',
    },
    {
      ...base,
      authoring: { genericShapes: 'none' },
      containers: { allowed: false },
      guidance: '   ',
    },
    { ...base, connectorPolicy: 'listed-only', containers: { allowed: true } },
    { ...base, allowedShapeIds: ['rectangle', 'diamond'], authoring: { genericShapes: 'listed' } },
  ];

  // --- tool lists and prompt sections -----------------------------------------------------------------------
  // Each distinct tool once (`toolDefs`); `tools` lists, per family and rule set, the indexes it offers in order.
  const toolDefs: any[] = [];
  const toolIndex = new Map<string, number>();
  const tools: any[] = [];
  const standards: any[] = [];
  for (const family of [...FAMILIES, 'gantt']) {
    for (let r = 0; r < rules.length; r += 1) {
      const offered = (await listTools(family, rules[r])).map((t) => {
        const text = JSON.stringify(t);
        if (!toolIndex.has(text)) toolIndex.set(text, toolDefs.push(t) - 1);
        return toolIndex.get(text);
      });
      tools.push({ family, rules: r, tools: offered });
      const { primer, standard } = promptSections(family, rules[r], {
        nodes: [],
        edges: [],
        containers: [],
      } as any);
      standards.push({ family, rules: r, primer, standard });
    }
  }

  const models: { name: string; family: string; model: any }[] = [];
  for (const family of FAMILIES)
    models.push({
      name: `empty-${family}`,
      family,
      model: { diagramTypeId: family, nodes: [], edges: [], containers: [] },
    });
  for (const c of readdirSync(join(CORPUS, 'cases')).sort()) {
    const dsl = readFileSync(join(CORPUS, 'cases', c, 'input.mmd'), 'utf8');
    if (dsl.length > 900) continue;
    const family = detectDslFamily(dsl);
    const parsed = family ? getDslFamily(family)?.parse(dsl) : undefined;
    if (family && parsed && isParseSuccess(parsed))
      models.push({ name: c, family, model: withoutNulls(json(parsed.model)) });
  }
  const prompts: any[] = [];
  for (const { name, family, model } of models) {
    for (const r of [0, 1 + Math.floor(rand() * (rules.length - 1))]) {
      prompts.push({
        case: name,
        family,
        rules: r,
        currentDiagram: promptSections(family, rules[r], model).currentDiagram,
      });
    }
  }

  // --- tool-call sequences ----------------------------------------------------------------------------------
  const labels = ['A', '', 'Two words', 'Ünïcode'];
  const colors = ['#ff0000', '#AABBCC', '#aabbcc', '#ffffff', '#112233', 'red'];
  const validInput = (tool: any, model: any): any => {
    const props = tool.inputSchema.properties;
    const nodeId = () => (chance(0.85) && model.nodes.length ? pick(model.nodes).id : 'ghost');
    const edgeId = () => (chance(0.85) && model.edges.length ? pick(model.edges).id : 'ghost');
    const gen = (key: string, schema: any): any => {
      if (schema.enum) return pick(schema.enum);
      if (schema.type === 'boolean') return chance(0.5);
      if (schema.type === 'number') return pick([1, 2.5, 12]);
      if (schema.type === 'array') {
        if (key === 'nodeIds') return [nodeId(), ...(chance(0.5) ? [nodeId()] : [])];
        return Array.from({ length: Math.floor(rand() * 3) }, () => gen(`${key}[]`, schema.items));
      }
      if (schema.type === 'object') return genObject(schema);
      if (key === 'nodeId' || key === 'sourceId' || key === 'targetId' || key === 'participantId')
        return nodeId();
      if (key === 'edgeId') return edgeId();
      if (key === 'fillColor' || key === 'strokeColor') return pick(colors);
      return pick(labels);
    };
    const genObject = (schema: any) => {
      const out: any = {};
      for (const [key, s] of Object.entries<any>(schema.properties)) {
        if (schema.required.includes(key) || chance(0.5)) out[key] = gen(key, s);
      }
      return out;
    };
    return genObject({ properties: props, required: tool.inputSchema.required });
  };
  const breakInput = (input: any): any => {
    switch (Math.floor(rand() * 7)) {
      case 0:
        return pick(['str', 3, null, [input]]);
      case 1: {
        const keys = Object.keys(input);
        if (keys.length) delete input[pick(keys)];
        return input;
      }
      case 2:
        input[pick(Object.keys(input).concat(['nodeId']))] = pick([5, true, null, { x: 1 }, ['a']]);
        return input;
      case 3:
        return { ...input, extra: 1 };
      case 4:
        for (const k of Object.keys(input))
          if (typeof input[k] === 'string') input[k] = 'not-in-any-enum';
        return input;
      case 5:
        for (const k of Object.keys(input))
          if (Array.isArray(input[k])) input[k] = input[k].length ? [7, ...input[k]] : [];
        return input;
      default:
        return {};
    }
  };

  const runs: any[] = [];
  for (const { name, family, model: start } of models) {
    for (let s = 0; s < 2; s += 1) {
      const r = s === 0 ? 0 : Math.floor(rand() * rules.length);
      const offered = await listTools(family, rules[r]);
      let model = start;
      const steps: any[] = [];
      for (let i = 0; i < 8; i += 1) {
        const unknown = chance(0.03);
        const tool = pick(offered);
        const toolName = unknown ? 'noSuchTool' : tool.name;
        let input = validInput(tool, model);
        if (chance(0.15)) input = breakInput(input);
        const before = new Set(
          [...model.nodes, ...model.edges, ...model.containers].map((x: any) => x.id),
        );
        const result: any = await runTool(
          family,
          rules[r],
          json(model),
          toolName,
          json(input ?? null),
        );
        const step: any = { name: toolName, input: json(input ?? null) };
        if (result.ok) {
          const next = json(result.model);
          step.ids = [...next.nodes, ...next.edges, ...next.containers]
            .map((x: any) => x.id)
            .filter((id: string) => !before.has(id));
          step.output = json(result.output);
          step.outcomes = json(result.outcomes);
          step.hash = digest(next);
          model = next;
        } else {
          step.error = result.error;
        }
        steps.push(step);
      }
      runs.push({ case: name, family, rules: r, steps });
    }
  }

  writeFileSync(
    process.env.OUT!,
    JSON.stringify({
      rules: rules.map((x) => x ?? null),
      models: Object.fromEntries(models.map((m) => [m.name, m.model])),
      toolDefs,
      tools,
      standards,
      prompts,
      runs,
    }) + '\n',
  );
});
