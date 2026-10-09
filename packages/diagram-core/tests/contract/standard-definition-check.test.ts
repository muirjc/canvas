import { describe, expect, it } from 'vitest';
import { checkStandardDefinition } from '../../src/standards/definition-check.js';
import { emptyStandardRules, type ConnectorRule, type ElementKind, type StandardRules } from '../../src/standards/schema.js';

// canvas-tfr: a standard's own definition must be coherent for its family before it can be saved.

const k = (id: string, over: Partial<ElementKind> = {}): ElementKind => ({ id, label: id, shapes: [], approvedFills: [], ...over });
const cr = (id: string, from: string, to: string): ConnectorRule => ({ id, label: id, from, to });
const rules = (over: Partial<StandardRules>): StandardRules => ({ ...emptyStandardRules(), ...over });
const paths = (r: StandardRules, family: string) => checkStandardDefinition(r, family).map((i) => i.path);

describe('checkStandardDefinition', () => {
  it('accepts a valid value-chain-like flowchart definition', () => {
    const r = rules({
      elementKinds: [
        k('primary_activity', { shapes: ['rounded-rectangle'], approvedFills: ['#dbeafe', '#abc'], approvedStrokes: ['#1e3a8a'], minCount: 1, maxCount: 8 }),
        k('support_activity', { shapes: ['rectangle'], approvedFills: ['#f3f4f6'] }),
      ],
      connectorRules: [cr('feeds', 'support_activity', 'primary_activity'), cr('any', '*', '*')],
      connectorPolicy: 'listed-only',
    });
    expect(checkStandardDefinition(r, 'flowchart')).toEqual([]);
  });

  it('accepts a v1-only definition on any family', () => {
    expect(checkStandardDefinition(emptyStandardRules(), 'sequence')).toEqual([]);
  });

  describe('kind ids', () => {
    it.each(['Primary-Activity', '1abc', 'has space', ''])('rejects invalid id %j', (id) => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k(id)] }), 'flowchart');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.path.includes('elementKinds[0]'))).toBe(true);
    });

    it.each(['default', 'end'])('rejects reserved id %s', (id) => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k(id)] }), 'flowchart');
      expect(issues.some((i) => i.path.includes('elementKinds[0]'))).toBe(true);
    });

    it('rejects duplicate ids, pointing at the later one', () => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k('a'), k('b'), k('a')] }), 'flowchart');
      expect(issues.some((i) => i.path.includes('elementKinds[2]'))).toBe(true);
      expect(issues.some((i) => i.path.includes('elementKinds[1]'))).toBe(false);
    });
  });

  it('rejects element kinds on a family that does not support them', () => {
    const issues = checkStandardDefinition(rules({ elementKinds: [k('a')] }), 'sequence');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.startsWith('elementKinds'))).toBe(true);
  });

  it('rejects a flowchart kind shape outside FAMILY_NODE_SHAPES.flowchart', () => {
    const issues = checkStandardDefinition(rules({ elementKinds: [k('a', { shapes: ['person'] })] }), 'flowchart');
    expect(issues.some((i) => i.path.includes('elementKinds[0].shapes'))).toBe(true);
  });

  it('accepts a C4 kind shape of person', () => {
    expect(checkStandardDefinition(rules({ elementKinds: [k('person', { shapes: ['person'] })] }), 'c4')).toEqual([]);
  });

  describe('colors', () => {
    it.each(['blue', '#12345', '#gggggg', '123456'])('rejects bad fill %s', (fill) => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k('a', { approvedFills: [fill] })] }), 'flowchart');
      expect(issues.some((i) => i.path.includes('elementKinds[0].approvedFills'))).toBe(true);
    });

    it('rejects a bad stroke', () => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k('a', { approvedStrokes: ['red'] })] }), 'flowchart');
      expect(issues.some((i) => i.path.includes('elementKinds[0].approvedStrokes'))).toBe(true);
    });

    it('accepts #rgb and #rrggbb', () => {
      expect(checkStandardDefinition(rules({ elementKinds: [k('a', { approvedFills: ['#abc', '#AABBCC'] })] }), 'flowchart')).toEqual([]);
    });
  });

  describe('counts', () => {
    it('rejects minCount > maxCount', () => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k('a', { minCount: 3, maxCount: 2 })] }), 'flowchart');
      expect(issues.some((i) => i.path.includes('elementKinds[0]'))).toBe(true);
    });

    it('rejects negative counts', () => {
      expect(checkStandardDefinition(rules({ elementKinds: [k('a', { minCount: -1 })] }), 'flowchart').length).toBeGreaterThan(0);
      expect(checkStandardDefinition(rules({ elementKinds: [k('a', { maxCount: -1 })] }), 'flowchart').length).toBeGreaterThan(0);
    });

    it('accepts equal min and max', () => {
      expect(checkStandardDefinition(rules({ elementKinds: [k('a', { minCount: 2, maxCount: 2 })] }), 'flowchart')).toEqual([]);
    });
  });

  describe('match', () => {
    it('rejects match on flowchart', () => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k('a', { match: { role: 'system' } })] }), 'flowchart');
      expect(issues.some((i) => i.path.includes('elementKinds[0].match'))).toBe(true);
    });

    it('rejects an unknown C4 match.role', () => {
      const issues = checkStandardDefinition(rules({ elementKinds: [k('a', { match: { role: 'widget' } })] }), 'c4');
      expect(issues.some((i) => i.path.includes('elementKinds[0].match'))).toBe(true);
    });

    it('accepts a known C4 match.role, with external', () => {
      expect(checkStandardDefinition(rules({ elementKinds: [k('ext', { match: { role: 'system', external: true } })] }), 'c4')).toEqual([]);
    });
  });

  describe('connector rules', () => {
    it('rejects a rule referencing an unknown kind on either side', () => {
      const r = rules({ elementKinds: [k('a')], connectorRules: [cr('r1', 'ghost', 'a'), cr('r2', 'a', 'ghost')] });
      const p = paths(r, 'flowchart');
      expect(p.some((x) => x.includes('connectorRules[0]'))).toBe(true);
      expect(p.some((x) => x.includes('connectorRules[1]'))).toBe(true);
    });

    it("accepts '*' on either side", () => {
      const r = rules({ elementKinds: [k('a')], connectorRules: [cr('r1', '*', 'a'), cr('r2', 'a', '*'), cr('r3', '*', '*')] });
      expect(checkStandardDefinition(r, 'flowchart')).toEqual([]);
    });

    it('rejects duplicate connector ids', () => {
      const r = rules({ elementKinds: [k('a')], connectorRules: [cr('dup', 'a', 'a'), cr('dup', 'a', '*')] });
      expect(paths(r, 'flowchart').some((x) => x.includes('connectorRules[1]'))).toBe(true);
    });
  });
});
