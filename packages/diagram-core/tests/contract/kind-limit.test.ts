import { describe, expect, it } from 'vitest';
import { createEmptyDiagramModel, type DiagramModel, type DiagramNode } from '../../src/model/diagram-model.js';
import { kindAddBlockedReason, kindLimitMessage, kindLimitReached } from '../../src/standards/kinds.js';
import { validate } from '../../src/standards/validator.js';
import { checkStandardDefinition } from '../../src/standards/definition-check.js';
import { emptyStandardRules, type ElementKind, type KindGroup, type StandardRules } from '../../src/standards/schema.js';

// canvas-8o01: "only one Component per diagram" -- the editor and the AI refuse to add past maxCount.
const COMPONENT: ElementKind = { id: 'component', label: 'Component', shapes: [], approvedFills: [], maxCount: 1 };
const STEP: ElementKind = { id: 'step', label: 'Step', shapes: [], approvedFills: [], maxCount: 2 };
const OPEN: ElementKind = { id: 'note', label: 'Note', shapes: [], approvedFills: [] };
const RULES: StandardRules = { ...emptyStandardRules(), elementKinds: [COMPONENT, STEP, OPEN] };

function model(roles: string[]): DiagramModel {
  return {
    ...createEmptyDiagramModel('flowchart'),
    nodes: roles.map((role, i) => ({ id: `n${i}`, label: role, shape: 'rectangle', role, position: { x: 0, y: 0 } }) as DiagramNode),
  };
}

describe('kindLimitReached', () => {
  it('is reached once the diagram holds maxCount elements of the kind', () => {
    expect(kindLimitReached(model([]), RULES, COMPONENT)).toBe(false);
    expect(kindLimitReached(model(['component']), RULES, COMPONENT)).toBe(true);
    expect(kindLimitReached(model(['step']), RULES, STEP)).toBe(false);
    expect(kindLimitReached(model(['step', 'step']), RULES, STEP)).toBe(true);
  });

  it('never applies to a kind without a maxCount', () => {
    expect(kindLimitReached(model(['note', 'note', 'note']), RULES, OPEN)).toBe(false);
  });

  it('leaves out the element being changed, so it does not count against itself', () => {
    expect(kindLimitReached(model(['component']), RULES, COMPONENT, 'n0')).toBe(false);
    expect(kindLimitReached(model(['component', 'step']), RULES, COMPONENT, 'n1')).toBe(true);
  });

  it('explains the limit in plain words', () => {
    expect(kindLimitMessage(COMPONENT)).toBe('This diagram already has its 1 Component.');
    expect(kindLimitMessage(STEP)).toBe('This diagram already has its 2 Step elements, the most allowed.');
  });
});

// canvas-thia: "one Component, whether New, Reused or Retired" -- a count across several kinds.
describe('kind groups', () => {
  const NEW: ElementKind = { id: 'new_component', label: 'New Component', shapes: [], approvedFills: [] };
  const REUSED: ElementKind = { id: 'reused_component', label: 'Reused Component', shapes: [], approvedFills: [] };
  const RETIRED: ElementKind = { id: 'retired_component', label: 'Retired Component', shapes: [], approvedFills: [] };
  const GROUPED: StandardRules = {
    ...emptyStandardRules(),
    elementKinds: [NEW, REUSED, RETIRED, OPEN],
    kindGroups: [{ id: 'component', label: 'Component', kindIds: ['new_component', 'reused_component', 'retired_component'], minCount: 1, maxCount: 1 }],
  };

  it('blocks adding any kind of the group once the group is full', () => {
    expect(kindAddBlockedReason(model([]), GROUPED, RETIRED)).toBeUndefined();
    expect(kindAddBlockedReason(model(['new_component']), GROUPED, RETIRED)).toBe(
      'This diagram already has its 1 Component (New Component, Reused Component or Retired Component).',
    );
    expect(kindAddBlockedReason(model(['new_component']), GROUPED, OPEN)).toBeUndefined();
  });

  it('lets an element of the group change to another kind of the same group', () => {
    expect(kindAddBlockedReason(model(['new_component']), GROUPED, RETIRED, 'n0')).toBeUndefined();
  });

  it("still applies a kind's own Max count first", () => {
    expect(kindAddBlockedReason(model(['component']), RULES, COMPONENT)).toBe('This diagram already has its 1 Component.');
  });

  it('flags too many and too few in the Issues list', () => {
    const tooMany = validate(model(['new_component', 'retired_component']), GROUPED).filter((v) => v.rule.startsWith('kind-group'));
    expect(tooMany).toEqual([
      expect.objectContaining({
        rule: 'kind-group-max-count',
        severity: 'error',
        message: 'Allows at most 1 Component (New Component, Reused Component or Retired Component); found 2.',
      }),
    ]);
    const none = validate(model(['note']), GROUPED).filter((v) => v.rule.startsWith('kind-group'));
    expect(none.map((v) => v.rule)).toEqual(['kind-group-min-count']);
    expect(validate(model(['reused_component']), GROUPED).filter((v) => v.rule.startsWith('kind-group'))).toEqual([]);
  });

  it('checks the definition: known kinds, at least two, a count, sane numbers', () => {
    const check = (group: Partial<KindGroup>) =>
      checkStandardDefinition({ ...GROUPED, kindGroups: [{ id: 'g', label: 'G', kindIds: ['new_component', 'reused_component'], maxCount: 1, ...group }] }, 'flowchart').map(
        (i) => i.message,
      );
    expect(check({})).toEqual([]);
    expect(check({ kindIds: ['new_component', 'ghost'] })).toEqual(['"ghost" isn\'t a defined element kind.']);
    expect(check({ kindIds: ['new_component'] })).toEqual(['A group needs at least two element kinds.']);
    expect(check({ maxCount: undefined })).toEqual(['Set a minimum or a maximum count for the group.']);
    expect(check({ minCount: 2, maxCount: 1 })).toEqual(['Minimum count 2 exceeds maximum 1.']);
    expect(check({ label: ' ' })).toEqual(['A group needs a name.']);
  });
});
