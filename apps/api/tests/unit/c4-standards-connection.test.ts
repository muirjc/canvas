import { describe, expect, it } from 'vitest';
import { getDslFamily, validate } from '@canvas/diagram-core';
import { BUILT_IN_STANDARDS, C4_CONTEXT_STANDARD } from '../../src/seed/reference-standards.seed.js';

/** canvas-1n3: the built-in C4 standards flag an element that isn't connected to anything -- as a
 *  Warning, which can be ignored and never blocks a GitHub submission (only Must fix does). */
function parse(dsl: string) {
  const result = getDslFamily('c4')!.parse(dsl);
  if ('errors' in result) throw new Error(JSON.stringify(result.errors));
  return result.model;
}
const unconnected = (rules: Parameters<typeof validate>[1], dsl: string) => validate(parse(dsl), rules).filter((v) => v.rule === 'kind-unconnected');

describe('C4 Context: unconnected elements', () => {
  it('a diagram with no relationships gets one Warning per element', () => {
    const issues = unconnected(C4_CONTEXT_STANDARD, 'C4Context\n  Person(user, "Customer")\n  System(shop, "Shop")\n  System_Ext(pay, "Payments")\n  Person_Ext(partner, "Partner")\n');
    expect(issues.map((v) => v.elementId).sort()).toEqual(['partner', 'pay', 'shop', 'user']);
    expect(issues.every((v) => v.severity === 'warning')).toBe(true);
    expect(issues.find((v) => v.elementId === 'user')?.message).toBe('Person "Customer" isn\'t connected to anything.');
  });

  it('connected elements are not flagged; only the loose one is', () => {
    const issues = unconnected(
      C4_CONTEXT_STANDARD,
      'C4Context\n  Person(user, "Customer")\n  System(shop, "Shop")\n  System_Ext(pay, "Payments")\n  Rel(user, shop, "Buys from")\n',
    );
    expect(issues.map((v) => v.elementId)).toEqual(['pay']);
  });

  it('never Must fix, so it cannot block submitting', () => {
    const all = validate(parse('C4Context\n  Person(user, "Customer")\n  System(shop, "Shop")\n'), C4_CONTEXT_STANDARD);
    expect(all.filter((v) => v.rule === 'kind-unconnected' && v.severity === 'error')).toEqual([]);
  });
});

describe('other built-in C4 standards', () => {
  const kindsOf = (id: string) => BUILT_IN_STANDARDS.find((s) => s.diagramTypeId === id)!.rules.elementKinds!;
  it('Container and Component require connections on every kind', () => {
    for (const id of ['c4-container', 'c4-component']) {
      expect(kindsOf(id).every((k) => k.requireConnection === true), id).toBe(true);
      expect(BUILT_IN_STANDARDS.find((s) => s.diagramTypeId === id)!.rules.severityOverrides?.['kind-unconnected'], id).toBe('warning');
    }
  });
  it('Code and Deployment do not (a plain list; nesting is the relationship)', () => {
    for (const id of ['c4-code', 'c4-deployment']) expect(kindsOf(id).some((k) => k.requireConnection), id).toBe(false);
  });
  it('the shared C4 kind definitions themselves are not changed', () => {
    // c4Starter copies the kind when adding requireConnection, so Code/Deployment stay unaffected.
    expect(kindsOf('c4-code').find((k) => k.id === 'container')?.requireConnection).toBeUndefined();
  });
});
