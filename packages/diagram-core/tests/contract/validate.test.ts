import { describe, expect, it } from 'vitest';
import { validate } from '../../src/standards/validator.js';
import { emptyStandardRules, type StandardRules } from '../../src/standards/schema.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * Constitution II: validate(model, standard) must be machine-checked and specific — Standards
 * Are Enforced, Not Advisory. Each rule dimension (shape, mandatory shape, icon library, color,
 * font) must be independently and correctly detected.
 */
describe('validate(model, standard)', () => {
  const baseModel: DiagramModel = {
    diagramTypeId: 'c4-context',
    nodes: [
      { id: 'p1', label: 'Customer', shape: 'person', role: 'person', position: { x: 0, y: 0 }, style: { fillColor: '#08427b' } },
      { id: 's1', label: 'System', shape: 'rectangle', role: 'system', position: { x: 200, y: 0 } },
    ],
    edges: [],
    containers: [],
  };

  it('reports no violations when the diagram fully complies', () => {
    const rules: StandardRules = {
      ...emptyStandardRules(),
      allowedShapeIds: ['person', 'rectangle'],
      mandatoryShapeIds: ['person'],
      colorPalette: [{ role: 'person', colorHex: '#08427b' }],
    };
    expect(validate(baseModel, rules)).toEqual([]);
  });

  it('flags a node using a shape outside the allowed list', () => {
    const rules: StandardRules = { ...emptyStandardRules(), allowedShapeIds: ['person'] };
    const violations = validate(baseModel, rules);
    expect(violations).toContainEqual(
      expect.objectContaining({ elementId: 's1', rule: 'allowed-shapes' }),
    );
  });

  it('flags a missing mandatory shape', () => {
    const rules: StandardRules = { ...emptyStandardRules(), mandatoryShapeIds: ['cylinder'] };
    const violations = validate(baseModel, rules);
    expect(violations).toContainEqual(expect.objectContaining({ rule: 'mandatory-shapes' }));
  });

  it('flags an icon from a non-approved library/version', () => {
    const modelWithIcon: DiagramModel = {
      ...baseModel,
      nodes: [
        {
          id: 'n1',
          label: 'Lambda',
          shape: 'icon',
          position: { x: 0, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2023.1', iconId: 'lambda' },
        },
      ],
    };
    const rules: StandardRules = {
      ...emptyStandardRules(),
      allowedIconLibraryRefs: [{ libraryId: 'aws-icons', libraryVersion: '2024.1' }],
    };
    const violations = validate(modelWithIcon, rules);
    expect(violations).toContainEqual(
      expect.objectContaining({ elementId: 'n1', rule: 'allowed-icon-libraries' }),
    );
  });

  it('flags a role-tagged node using a non-approved color', () => {
    const rules: StandardRules = {
      ...emptyStandardRules(),
      colorPalette: [{ role: 'person', colorHex: '#1168bd' }],
    };
    const violations = validate(baseModel, rules);
    expect(violations).toContainEqual(expect.objectContaining({ elementId: 'p1', rule: 'color-palette' }));
  });

  it('flags a font size outside the approved range', () => {
    const modelWithFont: DiagramModel = {
      ...baseModel,
      nodes: [{ ...baseModel.nodes[0], style: { ...baseModel.nodes[0].style, fontSize: 40 } }],
    };
    const rules: StandardRules = {
      ...emptyStandardRules(),
      fontConstraints: { minSize: 10, maxSize: 20 },
    };
    const violations = validate(modelWithFont, rules);
    expect(violations).toContainEqual(expect.objectContaining({ elementId: 'p1', rule: 'font-size' }));
  });

  it('is a pure function (same input always yields the same output)', () => {
    const rules: StandardRules = { ...emptyStandardRules(), allowedShapeIds: ['person'] };
    const first = validate(baseModel, rules);
    const second = validate(baseModel, rules);
    expect(first).toEqual(second);
  });
});
