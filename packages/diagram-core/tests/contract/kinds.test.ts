import { describe, expect, it } from 'vitest';
import { classifyNode, connectorDefaults, kindDefaults, resolveConnectorRule } from '../../src/standards/kinds.js';
import { emptyStandardRules, type ConnectorRule, type ElementKind, type StandardRules } from '../../src/standards/schema.js';
import type { DiagramNode } from '../../src/model/diagram-model.js';

// canvas-tfr: element-kind classification and connector-rule resolution.

const n = (over: Partial<DiagramNode>): DiagramNode => ({ id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, ...over });
const k = (id: string, over: Partial<ElementKind> = {}): ElementKind => ({ id, label: id, shapes: [], approvedFills: [], ...over });
const withKinds = (...kinds: ElementKind[]): StandardRules => ({ ...emptyStandardRules(), elementKinds: kinds });
const rule = (id: string, from: string, to: string, over: Partial<ConnectorRule> = {}): ConnectorRule => ({ id, label: id, from, to, ...over });
const withRules = (...rs: ConnectorRule[]): StandardRules => ({ ...emptyStandardRules(), connectorRules: rs });

describe('classifyNode', () => {
  it('matches a node whose role equals the kind id', () => {
    const rules = withKinds(k('primary'), k('support'));
    expect(classifyNode(n({ role: 'support' }), rules)?.id).toBe('support');
  });

  it('returns undefined for no role or an unmatched role', () => {
    const rules = withKinds(k('primary'));
    expect(classifyNode(n({}), rules)).toBeUndefined();
    expect(classifyNode(n({ role: 'other' }), rules)).toBeUndefined();
  });

  it('returns undefined when the standard has no elementKinds', () => {
    expect(classifyNode(n({ role: 'x' }), emptyStandardRules())).toBeUndefined();
  });

  it('uses match.role instead of the id', () => {
    const rules = withKinds(k('ext_system', { match: { role: 'system' } }));
    expect(classifyNode(n({ role: 'system' }), rules)?.id).toBe('ext_system');
    expect(classifyNode(n({ role: 'ext_system' }), rules)).toBeUndefined();
  });

  it('honors match.external true and false; absent external counts as false', () => {
    const rules = withKinds(
      k('ext_system', { match: { role: 'system', external: true } }),
      k('int_system', { match: { role: 'system', external: false } }),
    );
    expect(classifyNode(n({ role: 'system', external: true }), rules)?.id).toBe('ext_system');
    expect(classifyNode(n({ role: 'system', external: false }), rules)?.id).toBe('int_system');
    expect(classifyNode(n({ role: 'system' }), rules)?.id).toBe('int_system');
  });

  it('ignores external when match.external is not set', () => {
    const rules = withKinds(k('system'));
    expect(classifyNode(n({ role: 'system', external: true }), rules)?.id).toBe('system');
  });

  it('first matching kind in order wins', () => {
    const rules = withKinds(k('first', { match: { role: 'system' } }), k('second', { match: { role: 'system' } }));
    expect(classifyNode(n({ role: 'system' }), rules)?.id).toBe('first');
  });
});

describe('resolveConnectorRule', () => {
  it('prefers exact over one-sided wildcard over double wildcard regardless of order', () => {
    const rules = withRules(rule('any', '*', '*'), rule('fromP', 'primary', '*'), rule('exact', 'primary', 'support'));
    expect(resolveConnectorRule(rules, 'primary', 'support')?.id).toBe('exact');
    expect(resolveConnectorRule(rules, 'primary', 'other')?.id).toBe('fromP');
    expect(resolveConnectorRule(rules, 'other', 'other')?.id).toBe('any');
  });

  it('matches a wildcard on the to side', () => {
    const rules = withRules(rule('toS', '*', 'support'), rule('any', '*', '*'));
    expect(resolveConnectorRule(rules, 'primary', 'support')?.id).toBe('toS');
  });

  it("undefined endpoint kinds only match '*'", () => {
    const rules = withRules(rule('exact', 'primary', 'support'), rule('fromP', 'primary', '*'));
    expect(resolveConnectorRule(rules, 'primary', undefined)?.id).toBe('fromP');
    expect(resolveConnectorRule(rules, undefined, 'support')).toBeUndefined();
    expect(resolveConnectorRule(withRules(rule('any', '*', '*')), undefined, undefined)?.id).toBe('any');
  });

  it('returns undefined when nothing matches or there are no rules', () => {
    expect(resolveConnectorRule(withRules(rule('x', 'a', 'b')), 'b', 'a')).toBeUndefined();
    expect(resolveConnectorRule(emptyStandardRules(), 'a', 'b')).toBeUndefined();
  });
});

describe('kindDefaults', () => {
  it('uses the id as role, first shape, first fill/stroke', () => {
    const d = kindDefaults(k('primary', { shapes: ['rounded-rectangle', 'rectangle'], approvedFills: ['#dbeafe', '#fff'], approvedStrokes: ['#1e3a8a', '#000'] }));
    expect(d).toMatchObject({ role: 'primary', shape: 'rounded-rectangle', style: { fillColor: '#dbeafe', strokeColor: '#1e3a8a' } });
  });

  it('takes role and external from match', () => {
    const d = kindDefaults(k('ext_system', { match: { role: 'system', external: true } }));
    expect(d.role).toBe('system');
    expect(d.external).toBe(true);
  });

  it('omits shape and style when the lists are empty', () => {
    const d = kindDefaults(k('plain'));
    expect(d.role).toBe('plain');
    expect('shape' in d).toBe(false);
    expect('style' in d).toBe(false);
  });

  it('sets only the fill when there are no strokes', () => {
    const d = kindDefaults(k('p', { approvedFills: ['#abc'] }));
    expect(d.style?.fillColor).toBe('#abc');
    expect(d.style?.strokeColor).toBeUndefined();
  });
});

describe('connectorDefaults', () => {
  it('returns the first line style, arrow and stroke', () => {
    const d = connectorDefaults(rule('r', 'a', 'b', { lineStyles: ['dotted', 'solid'], arrows: ['both', 'target'], approvedStrokes: ['#123456'] }));
    expect(d).toEqual({ lineStyle: 'dotted', arrow: 'both', strokeColor: '#123456' });
  });

  it('leaves fields undefined when unconstrained', () => {
    const d = connectorDefaults(rule('r', 'a', 'b'));
    expect(d.lineStyle).toBeUndefined();
    expect(d.arrow).toBeUndefined();
    expect(d.strokeColor).toBeUndefined();
  });
});
