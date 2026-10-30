import { describe, expect, it } from 'vitest';
import { createEmptyDiagramModel, type DiagramModel, type DiagramNode } from '../../src/model/diagram-model.js';
import { kindLimitMessage, kindLimitReached } from '../../src/standards/kinds.js';
import { emptyStandardRules, type ElementKind, type StandardRules } from '../../src/standards/schema.js';

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
