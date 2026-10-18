import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { splitFrontMatter } from '../../src/dsl/front-matter.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { addElementOfKind, applyElementKind } from '../../src/model/standard-ops.js';
import { checkStandardDefinition } from '../../src/standards/definition-check.js';
import { classifyNode } from '../../src/standards/kinds.js';
import { emptyStandardRules, type StandardRules } from '../../src/standards/schema.js';
import { validate } from '../../src/standards/validator.js';

/**
 * jmuir-dtu.28: architecture services carried no role, so classifyNode() never matched them and a
 * standard's element kinds (approved fills, counts, connector rules, Issues-tab checks) never
 * applied to architecture diagrams at all. Mermaid's architecture-beta grammar has no class or tag
 * syntax to carry a kind, so it rides in front-matter (`canvas.kinds`), leaving the Mermaid body
 * portable; service styles now round-trip through `canvas.styles` too, so an approved fill sticks.
 */

const RULES: StandardRules = {
  ...emptyStandardRules(),
  elementKinds: [
    { id: 'core_service', label: 'Core Service', shapes: ['icon'], approvedFills: ['#dbeafe'] },
    { id: 'third_party', label: 'Third Party', shapes: [], approvedFills: ['#fde68a', '#fef3c7'], maxCount: 1 },
  ],
};

function parseOk(dsl: string): DiagramModel {
  const result = parseArchitecture(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

const KINDED = [
  '---',
  'canvas:',
  '  positions:',
  '    api: { x: 40, y: 40 }',
  '    pay: { x: 240, y: 40 }',
  '    j: { x: 440, y: 40 }',
  '  kinds:',
  '    api: core_service',
  '    pay: third_party',
  '    j: core_service',
  '  styles:',
  '    api: { fillColor: "#dbeafe" }',
  '---',
  'architecture-beta',
  '    service api(server)[API]',
  '    service pay(internet)[Payments]',
  '    junction j',
  '    api:R --> L:pay',
  '',
].join('\n');

describe('jmuir-dtu.28: a service kind round-trips through front-matter', () => {
  it('canvas.kinds sets the service role; canvas.styles sets its style', () => {
    const model = parseOk(KINDED);
    const api = model.nodes.find((n) => n.id === 'api')!;
    expect(api.role).toBe('core_service');
    expect(api.style).toEqual({ fillColor: '#dbeafe' });
    expect(model.nodes.find((n) => n.id === 'pay')!.role).toBe('third_party');
  });

  it('a junction keeps its junction role regardless of a kinds entry', () => {
    expect(parseOk(KINDED).nodes.find((n) => n.id === 'j')!.role).toBe('junction');
  });

  it('serialize writes kinds and styles to front-matter and nothing kind-related into the Mermaid body', () => {
    const out = serializeArchitecture(parseOk(KINDED));
    const { frontMatter, body } = splitFrontMatter(out);
    expect(frontMatter.canvas?.kinds).toEqual({ api: 'core_service', pay: 'third_party' });
    expect(frontMatter.canvas?.styles?.api).toEqual({ fillColor: '#dbeafe' });
    expect(body).not.toMatch(/core_service|third_party|junction j.*:::/);
    expect(body).toContain('service api(server)[API]');
  });

  it('parse -> serialize -> parse is idempotent', () => {
    const once = serializeArchitecture(parseOk(KINDED));
    expect(serializeArchitecture(parseOk(once))).toBe(once);
  });

  it('a diagram with no kinds or styles emits neither block', () => {
    const out = serializeArchitecture(parseOk('architecture-beta\n    service a(server)[A]\n'));
    const { frontMatter } = splitFrontMatter(out);
    expect(frontMatter.canvas?.kinds).toBeUndefined();
    expect(frontMatter.canvas?.styles).toBeUndefined();
  });
});

describe('jmuir-dtu.28: standards classify and validate architecture services', () => {
  it('classifyNode matches a kinded service and ignores an unkinded one', () => {
    const model = parseOk(KINDED);
    expect(classifyNode(model.nodes.find((n) => n.id === 'api')!, RULES)?.id).toBe('core_service');
    const plain = parseOk('architecture-beta\n    service a(server)[A]\n').nodes[0];
    expect(classifyNode(plain, RULES)).toBeUndefined();
  });

  it('the validator flags a kinded service filled with an unapproved colour', () => {
    const model = parseOk(KINDED.replace('api: { fillColor: "#dbeafe" }', 'api: { fillColor: "#ff0000" }'));
    const violations = validate(model, RULES);
    expect(violations.some((v) => v.elementId === 'api' && /#ff0000/i.test(v.message))).toBe(true);
  });

  it('requireKnownKinds flags an unkinded service but never a junction (junctions cannot be kinded)', () => {
    const model = parseOk(KINDED.replace('    pay: third_party\n', ''));
    const violations = validate(model, { ...RULES, requireKnownKinds: true });
    const unknown = violations.filter((v) => v.rule === 'unknown-kind').map((v) => v.elementId);
    expect(unknown).toEqual(['pay']);
  });

  it('the validator enforces a kind maxCount across services', () => {
    const extra = KINDED.replace('    pay: third_party', '    pay: third_party\n    pay2: third_party').replace(
      '    junction j',
      '    service pay2(internet)[Payments 2]\n    junction j',
    );
    const violations = validate(parseOk(extra), RULES);
    expect(violations.some((v) => /Third Party/.test(v.message))).toBe(true);
  });
});

describe('jmuir-dtu.28: creating and re-kinding services', () => {
  it('addElementOfKind with an icon fallback shape creates a service that survives a save', () => {
    const empty = parseOk('architecture-beta\n');
    const { model, nodeId } = addElementOfKind(empty, RULES.elementKinds![1], { label: 'Stripe', fallbackShape: 'icon' });
    const node = model.nodes.find((n) => n.id === nodeId)!;
    expect(node.shape).toBe('icon');
    expect(node.role).toBe('third_party');
    expect(node.style?.fillColor).toBe('#fde68a');

    const reparsed = parseOk(serializeArchitecture(model)).nodes.find((n) => n.id === nodeId)!;
    expect(reparsed.role).toBe('third_party');
    expect(reparsed.style?.fillColor).toBe('#fde68a');
    expect(reparsed.shape).toBe('icon');
  });

  it('applyElementKind on an imported service sets its kind and default fill', () => {
    const model = parseOk('architecture-beta\n    service a(server)[A]\n');
    const kinded = applyElementKind(model, 'a', RULES.elementKinds![0]);
    const reparsed = parseOk(serializeArchitecture(kinded)).nodes[0];
    expect(reparsed.role).toBe('core_service');
    expect(reparsed.style?.fillColor).toBe('#dbeafe');
    expect(reparsed.icon?.iconId).toBe('server');
  });
});

describe('jmuir-dtu.28: standard definitions for the architecture family', () => {
  it('element kinds are allowed for architecture', () => {
    expect(checkStandardDefinition(RULES, 'architecture')).toEqual([]);
  });

  it('"junction" is a reserved kind id for architecture (it is the junction role)', () => {
    const issues = checkStandardDefinition({ ...emptyStandardRules(), elementKinds: [{ id: 'junction', label: 'J', shapes: [], approvedFills: [] }] }, 'architecture');
    expect(issues.some((i) => i.path === 'elementKinds[0].id')).toBe(true);
  });

  it('an architecture kind may only use the service (icon) shape, not the junction circle', () => {
    const issues = checkStandardDefinition({ ...emptyStandardRules(), elementKinds: [{ id: 'hub', label: 'Hub', shapes: ['circle'], approvedFills: [] }] }, 'architecture');
    expect(issues.some((i) => i.path === 'elementKinds[0].shapes')).toBe(true);
  });

  it('flowchart is unaffected: "junction" stays a valid flowchart kind id', () => {
    expect(checkStandardDefinition({ ...emptyStandardRules(), elementKinds: [{ id: 'junction', label: 'J', shapes: [], approvedFills: [] }] }, 'flowchart')).toEqual([]);
  });
});
