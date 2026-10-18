import { describe, expect, it } from 'vitest';
import { parseC4, serializeC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel, DiagramNode } from '../../src/model/diagram-model.js';
import { addElementOfKind, applyElementKind } from '../../src/model/standard-ops.js';
import { classifyNode } from '../../src/standards/kinds.js';
import { emptyStandardRules, type ElementKind, type StandardRules } from '../../src/standards/schema.js';
import { validate } from '../../src/standards/validator.js';

/**
 * canvas-7hp: a C4 node's element kind was identified from its C4 role (+ external) alone, first
 * match wins -- so a standard with several kinds sharing one role (the AXA XL Product Context
 * standard: six System kinds, Re-Used / New / Enhanced / Outsource / Impaired / Retired) classified
 * every System as the first kind. Mermaid C4 macros take a named `$tags="..."` argument; it now
 * carries the kind per element. (It also used to hard-error: named arguments weren't accepted.)
 */

const system = (id: string, label: string, fill: string): ElementKind => ({
  id,
  label,
  shapes: ['rectangle'],
  approvedFills: [fill],
  match: { role: 'system', external: false },
});

const RULES: StandardRules = {
  ...emptyStandardRules(),
  elementKinds: [
    system('re_used', 'Re-Used System', '#9ca3af'),
    system('new_system', 'New System', '#22c55e'),
    system('enhanced_system', 'Enhanced System', '#3b82f6'),
    system('outsource_system', 'Outsource System', '#a855f7'),
    system('impaired_system', 'Impaired System', '#f97316'),
    system('retired_system', 'Retired System', '#ef4444'),
    { id: 'person', label: 'Person', shapes: ['person'], approvedFills: ['#08427b'], match: { role: 'person', external: false } },
  ],
};
const kind = (id: string) => RULES.elementKinds!.find((k) => k.id === id)!;

function parseOk(dsl: string): DiagramModel {
  const result = parseC4(dsl);
  expect(isParseSuccess(result), JSON.stringify((result as { errors?: unknown }).errors)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}
const node = (model: DiagramModel, id: string): DiagramNode => model.nodes.find((n) => n.id === id)!;

describe('canvas-7hp: $tags parses and round-trips', () => {
  it('accepts $tags after the label, and after a description', () => {
    const model = parseOk('C4Context\nSystem(a, "A", $tags="new_system")\nSystem(b, "B", "desc", $tags="v1, retired_system")\n');
    expect(node(model, 'a').tags).toEqual(['new_system']);
    expect(node(model, 'b').tags).toEqual(['v1', 'retired_system']);
  });

  it('accepts (and ignores) the other named arguments, in any order', () => {
    const model = parseOk('C4Context\nSystem(a, "A", $link="https://x", $tags="new_system", $sprite="db")\n');
    expect(node(model, 'a').tags).toEqual(['new_system']);
  });

  it('works on every element macro family, including _Ext variants', () => {
    const model = parseOk(
      'C4Container\nPerson_Ext(p, "P", $tags="t1")\nContainer(c, "C", "Java", "desc", $tags="t2")\nComponentDb(d, "D", $tags="t3")\n',
    );
    expect(node(model, 'p').tags).toEqual(['t1']);
    expect(node(model, 'p').external).toBe(true);
    expect(node(model, 'c').tags).toEqual(['t2']);
    expect(node(model, 'd').tags).toEqual(['t3']);
  });

  it('serializes tags back as $tags and round-trips idempotently', () => {
    const once = serializeC4(parseOk('C4Context\nSystem(a, "A", $tags="v1,new_system")\nPerson(p, "P")\n'));
    expect(once).toContain('System(a, "A", $tags="v1,new_system")');
    expect(once).toContain('Person(p, "P")');
    expect(serializeC4(parseOk(once))).toBe(once);
  });

  it('a diagram with no tags serializes exactly as before', () => {
    expect(serializeC4(parseOk('C4Context\nSystem(a, "A")\n'))).not.toContain('$tags');
  });
});

describe('canvas-7hp: tags pick between kinds that share a C4 role', () => {
  it('a tagged System classifies as its tagged kind, not the first System kind', () => {
    const model = parseOk('C4Context\nSystem(a, "A", $tags="new_system")\nSystem(b, "B", $tags="retired_system")\n');
    expect(classifyNode(node(model, 'a'), RULES)?.id).toBe('new_system');
    expect(classifyNode(node(model, 'b'), RULES)?.id).toBe('retired_system');
  });

  it('the first tag that names a fitting kind wins; unrelated tags are skipped', () => {
    const model = parseOk('C4Context\nSystem(a, "A", $tags="v1,enhanced_system,new_system")\n');
    expect(classifyNode(node(model, 'a'), RULES)?.id).toBe('enhanced_system');
  });

  it('an untagged System falls back to role matching (first System kind), as before', () => {
    expect(classifyNode(node(parseOk('C4Context\nSystem(a, "A")\n'), 'a'), RULES)?.id).toBe('re_used');
  });

  it('a tag naming a kind whose C4 role does not fit is ignored', () => {
    // 'person' is a Person kind; on a System it can't apply, so role matching decides.
    expect(classifyNode(node(parseOk('C4Context\nSystem(a, "A", $tags="person")\n'), 'a'), RULES)?.id).toBe('re_used');
  });

  it('the validator checks a tagged System against its own kind\'s fills', () => {
    const ok = parseOk('C4Context\nSystem(a, "A", $tags="new_system")\n');
    ok.nodes[0].style = { fillColor: '#22c55e' };
    expect(validate(ok, RULES).filter((v) => v.rule === 'kind-fill')).toEqual([]);

    const wrong = parseOk('C4Context\nSystem(a, "A", $tags="new_system")\n');
    wrong.nodes[0].style = { fillColor: '#9ca3af' }; // Re-Used's colour
    const fills = validate(wrong, RULES).filter((v) => v.rule === 'kind-fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].message).toContain('New System');
  });
});

describe('canvas-7hp: applying a kind writes the tag only when it is needed', () => {
  it('addElementOfKind tags an element whose kind shares its role with other kinds', () => {
    const { model, nodeId } = addElementOfKind(parseOk('C4Context\n'), kind('new_system'), { label: 'Claims', rules: RULES });
    const added = node(model, nodeId);
    expect(added.role).toBe('system');
    expect(added.tags).toEqual(['new_system']);
    expect(added.style?.fillColor).toBe('#22c55e');
    const reparsed = node(parseOk(serializeC4(model)), nodeId);
    expect(classifyNode(reparsed, RULES)?.id).toBe('new_system');
  });

  it('even the first of several System kinds is tagged, so reordering kinds later cannot change it', () => {
    const { model, nodeId } = addElementOfKind(parseOk('C4Context\n'), kind('re_used'), { rules: RULES });
    expect(node(model, nodeId).tags).toEqual(['re_used']);
  });

  it('a kind that is unique for its role gets no tag', () => {
    const { model, nodeId } = addElementOfKind(parseOk('C4Context\n'), kind('person'), { rules: RULES });
    expect(node(model, nodeId).tags).toBeUndefined();
    expect(serializeC4(model)).not.toContain('$tags');
  });

  it('applyElementKind replaces the previous kind tag and keeps unrelated tags', () => {
    const model = parseOk('C4Context\nSystem(a, "A", $tags="v1,new_system")\n');
    const next = applyElementKind(model, 'a', kind('retired_system'), RULES);
    expect(node(next, 'a').tags).toEqual(['retired_system', 'v1']);
    expect(classifyNode(node(next, 'a'), RULES)?.id).toBe('retired_system');
    expect(node(next, 'a').style?.fillColor).toBe('#ef4444');
  });

  it('applyElementKind to a unique kind drops stale kind tags but keeps unrelated ones', () => {
    const model = parseOk('C4Context\nPerson(p, "P", $tags="v1,new_system")\n');
    const next = applyElementKind(model, 'p', kind('person'), RULES);
    expect(node(next, 'p').tags).toEqual(['v1']);
  });

  it('without rules, applying a kind behaves exactly as before (no tags touched)', () => {
    const { model, nodeId } = addElementOfKind(parseOk('C4Context\n'), kind('new_system'));
    expect(node(model, nodeId).tags).toBeUndefined();
  });
});
