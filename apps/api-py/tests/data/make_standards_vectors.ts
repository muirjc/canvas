/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off generator writing loosely typed JSON vectors. */
// Regenerates standards_vectors.json: what the TypeScript diagram-core's standards code returns -- the definition
// check and its notices, the element-kind helpers, the authoring scope, and validate() on hand-made models (font
// rules, JSON nulls) the parsers can't produce -- for tests/test_diagram_core_standards.py. It imports
// diagram-core's source, so it runs inside that package's vitest: copy it to
// packages/diagram-core/tests/zz-tmp-gen.test.ts, then from packages/diagram-core
//   OUT=<repo>/apps/api-py/tests/data/standards_vectors.json npx vitest run tests/zz-tmp-gen.test.ts
// and delete the copy (and restore .vitest/json/output.json, which every vitest run rewrites).
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { effectiveAuthoring, iconLibraryOffered, offeredShapes } from '../src/standards/authoring.js';
import { checkStandardDefinition, standardDefinitionNotices } from '../src/standards/definition-check.js';
import {
  classifyNode,
  connectorDefaults,
  countKindGroup,
  isApprovedColor,
  kindAddBlockedReason,
  kindDefaults,
  kindGroupLimitMessage,
  kindGroupMembers,
  kindLimitMessage,
  kindLimitReached,
  kindNeedsTag,
  resolveConnectorRule,
  tagsForKind,
} from '../src/standards/kinds.js';
import { validate } from '../src/standards/validator.js';
import { FAMILY_NODE_SHAPES } from '../src/model/family-capabilities.js';

const base = { allowedShapeIds: [], mandatoryShapeIds: [], allowedIconLibraryRefs: [], colorPalette: [] };
const kind = (id: string, extra: any = {}) => ({ id, label: id.toUpperCase(), shapes: [], approvedFills: [], ...extra });

it('gen', () => {
  const definitions: any[] = [];
  const define = (family: string, rules: any) => {
    const r = { ...base, ...rules };
    definitions.push({ family, rules: r, issues: checkStandardDefinition(r, family), notices: standardDefinitionNotices(r, family) });
  };
  for (const family of ['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml', 'gantt']) {
    define(family, {});
    define(family, { elementKinds: [kind('a'), kind('b', { shapes: ['rectangle', 'icon', 'person', 'rounded-rectangle'] })] });
  }
  define('flowchart', { authoring: { shapes: 'listed', icons: 'listed' } });
  define('flowchart', { authoring: { shapes: 'none', icons: 'none' } });
  define('flowchart', { authoring: { shapes: 'none', icons: 'none' }, elementKinds: [kind('a')] });
  define('flowchart', { allowedShapeIds: ['rectangle'], allowedIconLibraryRefs: [{ libraryId: 'x', libraryVersion: '1' }], authoring: { shapes: 'listed', icons: 'listed' } });
  define('flowchart', {
    elementKinds: [
      kind('Bad'),
      kind('1abc'),
      kind('a-b'),
      kind('end'),
      kind('ClassDef'),
      kind('direction'),
      kind('ok'),
      kind('ok'),
      kind('blank', { label: '   ' }),
      kind('nolabel', { label: undefined }),
      kind('colours', { approvedFills: ['#fff', '#ABCDEF', 'red', '#abcd', '#12345g', '#fff\n'], approvedStrokes: ['#000', 'blue'] }),
      kind('neg', { minCount: -1 }),
      kind('negmax', { maxCount: -2 }),
      kind('minmax', { minCount: 3, maxCount: 2 }),
      kind('minmax_ok', { minCount: 2, maxCount: 2 }),
      kind('matched', { match: { role: 'system' } }),
      kind('ok\n'),
    ],
  });
  define('architecture', { elementKinds: [kind('junction'), kind('svc', { shapes: ['icon', 'circle'] })] });
  define('c4', {
    elementKinds: [
      kind('person', { shapes: ['person', 'rectangle'] }),
      kind('ext', { match: { role: 'person', external: true }, shapes: ['cylinder'] }),
      kind('bad_role', { match: { role: 'database' } }),
      kind('nomatch_role', { match: {} }),
      kind('system', { shapes: ['rectangle', 'cylinder', 'stadium', 'rounded-rectangle', 'person'] }),
      kind('container', { shapes: ['rounded-rectangle', 'rectangle'] }),
      kind('component', { shapes: ['hexagon'] }),
      kind('freeform', { shapes: ['rectangle'] }),
    ],
  });
  define('flowchart', {
    elementKinds: [kind('a'), kind('b'), kind('c')],
    kindGroups: [
      { id: 'g', label: 'G', kindIds: ['a', 'b'], minCount: 1 },
      { id: 'g', label: '', kindIds: ['a', 'a'], maxCount: 2 },
      { id: 'G2', label: 'x', kindIds: ['a', 'zz', 'b'] },
      { id: 'neg', label: 'x', kindIds: ['a', 'b'], minCount: -1, maxCount: 0 },
      { id: 'mm', label: 'x', kindIds: ['b', 'c'], minCount: 5, maxCount: 1 },
      { id: 'one', label: ' ', kindIds: [] },
    ],
    connectorRules: [
      { id: 'r', label: 'R', from: '*', to: 'a' },
      { id: 'r', label: 'R', from: 'zz', to: '*', approvedStrokes: ['#123', 'nope'] },
      { id: 's', label: 'S', from: 'a', to: 'missing' },
    ],
  });
  define('c4', {
    elementKinds: [
      kind('internal_sys', { label: 'Internal', match: { role: 'system', external: false } }),
      kind('any_sys', { label: ' Any ', match: { role: 'system' } }),
      kind('ext_sys', { label: '', match: { role: 'system', external: true } }),
      kind('person', { label: 'Person' }),
      kind('person_two', { label: 'P2', match: { role: 'person' } }),
      kind('ext_person', { label: 'EP', match: { role: 'person', external: true } }),
    ],
  });
  define('flowchart', { elementKinds: [kind('a', { match: { role: 'x', external: true } })] });

  // ---- element-kind helpers on a model ----
  const kindsRules: any = {
    ...base,
    elementKinds: [
      kind('sys', { label: 'System', match: { role: 'system' }, maxCount: 2, shapes: ['rectangle', 'cylinder'], approvedFills: ['#111'], approvedStrokes: ['#222', '#333'] }),
      kind('ext', { label: 'External', match: { role: 'system', external: true }, maxCount: 1 }),
      kind('legacy', { label: 'Legacy', match: { role: 'system', external: false } }),
      kind('person', { label: 'Person', maxCount: 0 }),
      kind('one', { label: 'One', maxCount: 1 }),
      kind('free', { label: 'Free', match: { role: 'free' } }),
      kind('nolimit', { label: 'No limit' }),
    ],
    kindGroups: [
      { id: 'systems', label: 'System', kindIds: ['sys', 'ext', 'legacy'], maxCount: 3 },
      { id: 'single', label: 'Single', kindIds: ['one'], maxCount: 1 },
      { id: 'empty', label: 'Empty', kindIds: [] },
      { id: 'unknowns', label: 'Unknowns', kindIds: ['ghost', 'sys'], minCount: 1 },
      { id: 'pair', label: 'Pair', kindIds: ['free', 'nolimit'], maxCount: 2 },
    ],
    connectorRules: [
      { id: 'any', label: 'Any', from: '*', to: '*' },
      { id: 'from_sys', label: 'From sys', from: 'sys', to: '*', arrows: ['both', 'none'], lineStyles: ['dotted'], approvedStrokes: ['#f00'] },
      { id: 'to_ext', label: 'To ext', from: '*', to: 'ext', arrows: [] },
      { id: 'exact', label: 'Exact', from: 'sys', to: 'ext' },
      { id: 'exact2', label: 'Exact again', from: 'sys', to: 'ext' },
    ],
  };
  const model: any = {
    diagramTypeId: 'c4-context',
    nodes: [
      { id: 'n1', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'system' },
      { id: 'n2', label: 'B', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'system', external: true },
      { id: 'n3', label: 'C', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'system', tags: ['legacy'] },
      { id: 'n4', label: 'D', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'system', tags: ['nope', 'ext', 'sys'] },
      { id: 'n5', label: 'E', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'person', tags: ['x', 'person', 'y'] },
      { id: 'n6', label: 'F', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'one' },
      { id: 'n7', label: 'G', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'n8', label: 'H', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'free' },
      { id: 'n9', label: 'I', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'free' },
      { id: 'n10', label: 'J', shape: 'rectangle', position: { x: 0, y: 0 }, role: '' },
    ],
    edges: [],
    containers: [],
  };
  const kinds: any = { rules: kindsRules, model, classify: {}, needsTag: {}, tags: {}, defaults: {}, blocked: {}, limitReached: {}, limitMessage: {}, groups: {}, connectorDefaults: {}, resolve: [], approved: [] };
  for (const node of model.nodes) kinds.classify[node.id] = classifyNode(node, kindsRules)?.id ?? null;
  for (const k of kindsRules.elementKinds) {
    kinds.needsTag[k.id] = kindNeedsTag(k, kindsRules);
    kinds.defaults[k.id] = kindDefaults(k);
    kinds.limitMessage[k.id] = kindLimitMessage(k);
    kinds.tags[k.id] = Object.fromEntries(model.nodes.map((n: any) => [n.id, tagsForKind(n, k, kindsRules) ?? null]));
    kinds.blocked[k.id] = Object.fromEntries([undefined, ...model.nodes.map((n: any) => n.id)].map((ignore) => [ignore ?? '(none)', kindAddBlockedReason(model, kindsRules, k, ignore) ?? null]));
    kinds.limitReached[k.id] = kindLimitReached(model, kindsRules, k);
  }
  for (const g of kindsRules.kindGroups) {
    kinds.groups[g.id] = { members: kindGroupMembers(g, kindsRules), count: countKindGroup(model, kindsRules, g), countIgnoring: countKindGroup(model, kindsRules, g, 'n1'), limitMessage: kindGroupLimitMessage(g, kindsRules) };
  }
  for (const r of kindsRules.connectorRules) kinds.connectorDefaults[r.id] = connectorDefaults(r);
  for (const from of [undefined, 'sys', 'ext', 'legacy', 'zz']) {
    for (const to of [undefined, 'sys', 'ext', 'legacy', 'zz']) {
      kinds.resolve.push([from ?? null, to ?? null, resolveConnectorRule(kindsRules, from, to)?.id ?? null]);
      kinds.resolve.push([from ?? null, to ?? null, resolveConnectorRule({ ...base, connectorRules: kindsRules.connectorRules.slice(1, 3) } as any, from, to)?.id ?? null, 'subset']);
    }
  }
  for (const [c, list] of [['#ABC', ['#abc']], ['#abc', ['#ABC', '#def']], ['#abc', []], ['red', ['RED']], ['#abcd', ['#abc']]] as const) {
    kinds.approved.push([c, list, isApprovedColor(c, list as any)]);
  }

  // ---- authoring ----
  const authoring: any[] = [];
  const familyShapes = FAMILY_NODE_SHAPES.flowchart;
  for (const rules of [
    undefined,
    { ...base },
    { ...base, allowedShapeIds: ['diamond', 'rectangle'], allowedIconLibraryRefs: [{ libraryId: 'aws-icons', libraryVersion: '1' }] },
    { ...base, requireKnownKinds: true, elementKinds: [kind('a')] },
    { ...base, requireKnownKinds: true, elementKinds: [] },
    { ...base, requireKnownKinds: true, elementKinds: [kind('a')], authoring: { shapes: 'all', icons: 'listed' } },
    { ...base, allowedShapeIds: ['circle'], authoring: { shapes: 'listed' } },
    { ...base, authoring: { icons: 'none' } },
  ] as any[]) {
    authoring.push({
      rules: rules ?? null,
      effective: effectiveAuthoring(rules),
      offered: offeredShapes(familyShapes, rules),
      icons: Object.fromEntries(['generic', 'aws-icons', 'azure-icons'].map((id) => [id, iconLibraryOffered(id, rules)])),
    });
  }

  // ---- validate on hand-made models ----
  const validations: any[] = [];
  const check = (name: string, m: any, rules: any) => {
    const r = { ...base, ...rules };
    validations.push({ name, model: m, rules: r, violations: validate(m, r) });
  };
  const node = (id: string, extra: any = {}) => ({ id, label: id.toUpperCase(), shape: 'rectangle', position: { x: 0, y: 0 }, ...extra });
  const fonts = {
    diagramTypeId: 'flowchart',
    nodes: [
      node('a', { style: { fontFamily: 'Arial', fontSize: 8 } }),
      node('b', { style: { fontFamily: 'Inter', fontSize: 24.5 } }),
      node('c', { style: { fontSize: 10 } }),
      node('d', { style: { fontFamily: '', fontSize: 20 } }),
      node('e', { style: {} }),
      node('f', { style: { fontSize: null } }),
      node('g'),
      node('h', { style: { fontSize: 0.0000001 } }),
      node('i', { style: { fontSize: 1e21 } }),
    ],
    edges: [],
    containers: [],
  };
  check('fonts-all', fonts, { fontConstraints: { family: 'Inter', minSize: 10, maxSize: 20 } });
  check('fonts-min-only', fonts, { fontConstraints: { minSize: 12 } });
  check('fonts-null-bounds', fonts, { fontConstraints: { family: '', minSize: null, maxSize: null } });
  check('fonts-empty', fonts, { fontConstraints: {} });
  check('fonts-null', fonts, { fontConstraints: null });
  const nulls = {
    diagramTypeId: 'c4-container',
    nodes: [
      node('p', { role: 'person', style: { fillColor: null, strokeColor: '#073B6F' } }),
      node('s', { role: 'system', external: true, label: null }),
      node('q', { role: 'system', style: { fillColor: '' } }),
      node('k', { role: 'container', shape: 'rounded-rectangle', tags: ['svc'] }),
      node('u', { role: null }),
      node('j', { role: 'junction' }),
      node('nolabel', { role: 'mystery', label: undefined }),
    ],
    edges: [
      { id: 'e1', sourceId: 'p', targetId: 's', label: '  ', arrow: null, lineStyle: null, style: { strokeColor: '#ABC' } },
      { id: 'e2', sourceId: 'p', targetId: 'q', label: 'Uses', style: {} },
      { id: 'e3', sourceId: 'p', targetId: 'k' },
      { id: 'e4', sourceId: 'k', targetId: 'missing', arrow: 'none', lineStyle: 'thick' },
      { id: 'e5', sourceId: 'u', targetId: 'u', label: 'self' },
      { id: 'e6', sourceId: 'p', targetId: 's', label: 'again', style: { strokeColor: '#abc' } },
    ],
    containers: [
      { id: 'c1', label: 'Plain', position: { x: 0, y: 0 } },
      { id: 'c2', label: 'Sys', role: 'system-boundary', position: { x: 0, y: 0 } },
      { id: 'c3', role: 'boundary', position: { x: 0, y: 0 } },
    ],
  };
  const c4Rules = {
    requireKnownKinds: true,
    elementKinds: [
      kind('person', { label: 'Person', shapes: ['person'], approvedFills: ['#08427B'], approvedStrokes: ['#073b6f'], minCount: null, maxCount: 0 }),
      kind('ext_system', { label: 'External', match: { role: 'system', external: true }, approvedFills: ['#999999'], approvedStrokes: ['#8a8a8a'], requireConnection: true }),
      kind('system', { label: null, match: { role: 'system', external: null }, approvedFills: ['#1168bd'], minCount: 3 }),
      kind('svc', { label: 'Service', match: { role: 'container' }, approvedFills: ['#438DD5'], approvedStrokes: [], requireConnection: true, maxCount: 0.5 }),
    ],
    kindGroups: [
      { id: 'everyone', label: 'Everyone', kindIds: ['person', 'svc', null], minCount: 1, maxCount: 1 },
      { id: 'nulls', label: null, kindIds: ['ghost'], minCount: 2, maxCount: null },
    ],
    connectorRules: [
      { id: 'uses', label: 'Uses', from: 'person', to: '*', requireLabel: true, maxPerSource: 1, approvedStrokes: ['#abc'], lineStyles: ['solid'], arrows: ['target'] },
      { id: 'out', label: 'Out', from: 'svc', to: '*', arrows: ['target'], lineStyles: ['dotted', 'thick'], maxPerSource: 0 },
    ],
    connectorPolicy: 'listed-only',
    containers: { allowed: true, allowedRoles: ['system-boundary', ''] },
    colorPalette: [{ role: 'person', colorHex: '#08427b' }, { role: 'system', colorHex: '#123456' }, { role: 'system', colorHex: '#654321' }],
    severityOverrides: { 'kind-fill': 'error', 'connector-max-per-source': null, 'kind-max-count': 'info' },
  };
  check('c4-nulls', nulls, c4Rules);
  check('c4-nulls-not-c4', { ...nulls, diagramTypeId: 'flowchart' }, c4Rules);
  check('c4-nulls-no-type', { ...nulls, diagramTypeId: undefined }, c4Rules);
  check('containers-off', nulls, { containers: { allowed: false } });
  check('containers-null-roles-off', nulls, { containers: { allowed: 0 } });
  check('policy-listed-no-rules', nulls, { connectorPolicy: 'listed-only' });
  check('shapes-none-icons', {
    diagramTypeId: 'architecture',
    nodes: [
      node('a', { shape: 'icon', icon: { libraryId: 'aws-icons', libraryVersion: '1', iconId: 'x' } }),
      node('b', { icon: { libraryId: 'generic', libraryVersion: '1', iconId: 'rectangle' } }),
      node('c', { role: 'svc', icon: { libraryId: 'azure-icons', libraryVersion: '1', iconId: 'x' } }),
      node('d', { role: 'junction', shape: 'circle' }),
      node('e', { shape: 'diamond' }),
    ],
    edges: [],
    containers: [],
  }, { elementKinds: [kind('svc')], authoring: { shapes: 'none', icons: 'none' } });
  check('icons-listed-empty-refs', { diagramTypeId: 'x', nodes: [node('a', { icon: { libraryId: 'aws-icons' } })], edges: [], containers: [] }, { authoring: { icons: 'listed' } });
  check('severity-unknown-override', { diagramTypeId: 'x', nodes: [node('a', { shape: 'circle' })], edges: [], containers: [] }, { allowedShapeIds: ['rectangle'], severityOverrides: { 'allowed-shapes': 'info', nonsense: 'error' } });

  writeFileSync(process.env.OUT!, JSON.stringify({ definitions, kinds, authoring, validations }));
});
