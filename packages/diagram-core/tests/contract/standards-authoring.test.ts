import { describe, expect, it } from 'vitest';
import { createEmptyDiagramModel, type DiagramModel, type DiagramNode } from '../../src/model/diagram-model.js';
import { effectiveAuthoring, iconLibraryOffered, offeredShapes } from '../../src/standards/authoring.js';
import { checkStandardDefinition } from '../../src/standards/definition-check.js';
import { emptyStandardRules, type StandardRules } from '../../src/standards/schema.js';
import { validate } from '../../src/standards/validator.js';

/**
 * canvas-7ewa / canvas-wid: a standard says what authors can add besides its element kinds --
 * generic shapes and icons: all, only those listed, or none. The editor, the AI and these checks
 * all read effectiveAuthoring().
 */

const KIND = { id: 'component', label: 'Component', shapes: ['rectangle' as const], approvedFills: ['#dbeafe'] };
const FAMILY = ['rectangle', 'rounded-rectangle', 'circle', 'diamond'] as const;

function rules(extra: Partial<StandardRules> = {}): StandardRules {
  return { ...emptyStandardRules(), ...extra };
}

function model(nodes: Partial<DiagramNode>[]): DiagramModel {
  return {
    ...createEmptyDiagramModel('flowchart'),
    nodes: nodes.map((n, i) => ({ id: `n${i}`, label: `N${i}`, shape: 'rectangle', position: { x: 0, y: 0 }, ...n }) as DiagramNode),
  };
}

const rulesOf = (violations: { rule: string }[], rule: string) => violations.filter((v) => v.rule === rule);

describe('effectiveAuthoring: existing standards keep their behaviour', () => {
  it('no standard, or an empty one: everything is offered', () => {
    expect(effectiveAuthoring(undefined)).toEqual({ shapes: 'all', icons: 'all' });
    expect(effectiveAuthoring(rules())).toEqual({ shapes: 'all', icons: 'all' });
  });

  it('a strict standard (every element must be a kind) offers only its kinds', () => {
    expect(effectiveAuthoring(rules({ elementKinds: [KIND], requireKnownKinds: true }))).toEqual({ shapes: 'none', icons: 'none' });
  });

  it('existing allowed lists mean "only these"', () => {
    expect(
      effectiveAuthoring(rules({ allowedShapeIds: ['diamond'], allowedIconLibraryRefs: [{ libraryId: 'azure-icons', libraryVersion: '1' }] })),
    ).toEqual({ shapes: 'listed', icons: 'listed' });
  });

  it('an explicit setting wins', () => {
    expect(effectiveAuthoring(rules({ elementKinds: [KIND], requireKnownKinds: true, authoring: { shapes: 'all', icons: 'listed' } }))).toEqual({
      shapes: 'all',
      icons: 'listed',
    });
  });
});

describe('offeredShapes and iconLibraryOffered', () => {
  it('offers the family shapes, only the listed ones, or none', () => {
    expect(offeredShapes(FAMILY, rules())).toEqual([...FAMILY]);
    expect(offeredShapes(FAMILY, rules({ authoring: { shapes: 'listed' }, allowedShapeIds: ['diamond', 'hexagon'] }))).toEqual(['diamond']);
    expect(offeredShapes(FAMILY, rules({ authoring: { shapes: 'none' } }))).toEqual([]);
  });

  it('offers icon libraries by id, whatever the version listed', () => {
    const listed = rules({ authoring: { icons: 'listed' }, allowedIconLibraryRefs: [{ libraryId: 'azure-icons', libraryVersion: '1.0.0' }] });
    expect(iconLibraryOffered('azure-icons', listed)).toBe(true);
    expect(iconLibraryOffered('aws-icons', listed)).toBe(false);
    expect(iconLibraryOffered('aws-icons', rules({ authoring: { icons: 'none' } }))).toBe(false);
    expect(iconLibraryOffered('aws-icons', rules())).toBe(true);
  });

  it('treats the generic shape-alias library as shapes, not icons', () => {
    expect(iconLibraryOffered('generic', rules({ authoring: { shapes: 'none', icons: 'all' } }))).toBe(false);
    expect(iconLibraryOffered('generic', rules({ authoring: { shapes: 'all', icons: 'none' } }))).toBe(true);
    // A strict standard (canvas-wid's Value Chain case) hides them.
    expect(iconLibraryOffered('generic', rules({ elementKinds: [KIND], requireKnownKinds: true }))).toBe(false);
  });
});

describe('validate follows the setting for DSL and imported elements', () => {
  it('"Generic shapes: None" flags a shape that is not one of the kinds, but not a kind element', () => {
    const r = rules({ elementKinds: [KIND], authoring: { shapes: 'none' } });
    const v = validate(model([{ shape: 'diamond' }, { shape: 'rectangle', role: 'component' }]), r);
    const flagged = rulesOf(v, 'allowed-shapes');
    expect(flagged.map((x) => x.elementId)).toEqual(['n0']);
    expect(flagged[0].message).toContain("doesn't use generic shapes");
  });

  it('a strict standard leaves it to unknown-kind (no double finding)', () => {
    const r = rules({ elementKinds: [KIND], requireKnownKinds: true });
    const v = validate(model([{ shape: 'diamond' }]), r);
    expect(rulesOf(v, 'allowed-shapes')).toEqual([]);
    expect(rulesOf(v, 'unknown-kind')).toHaveLength(1);
  });

  it('"Icons: None" flags an icon on a non-kind element', () => {
    const r = rules({ elementKinds: [KIND], authoring: { icons: 'none' } });
    const v = validate(model([{ shape: 'icon', icon: { libraryId: 'azure-icons', libraryVersion: '1', iconId: 'vm' } }]), r);
    expect(rulesOf(v, 'allowed-icon-libraries')).toHaveLength(1);
  });

  it('"Icons: Only these" accepts any version of a listed library', () => {
    const r = rules({ allowedIconLibraryRefs: [{ libraryId: 'azure-icons', libraryVersion: '1.0.0' }] });
    const v = validate(
      model([
        { shape: 'icon', icon: { libraryId: 'azure-icons', libraryVersion: '2.0.0', iconId: 'vm' } },
        { shape: 'icon', icon: { libraryId: 'aws-icons', libraryVersion: '1.0.0', iconId: 'ec2' } },
      ]),
      r,
    );
    expect(rulesOf(v, 'allowed-icon-libraries').map((x) => x.elementId)).toEqual(['n1']);
  });

  it('"All" adds no findings', () => {
    const v = validate(model([{ shape: 'diamond' }, { shape: 'icon', icon: { libraryId: 'x', libraryVersion: '1', iconId: 'y' } }]), rules());
    expect(rulesOf(v, 'allowed-shapes')).toEqual([]);
    expect(rulesOf(v, 'allowed-icon-libraries')).toEqual([]);
  });
});

describe('checkStandardDefinition', () => {
  it('asks for at least one choice under "Only these"', () => {
    const issues = checkStandardDefinition(rules({ authoring: { shapes: 'listed', icons: 'listed' } }), 'flowchart');
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['authoring.shapes', 'authoring.icons']));
  });

  it('refuses a standard that leaves authors nothing to add', () => {
    const issues = checkStandardDefinition(rules({ authoring: { shapes: 'none', icons: 'none' } }), 'flowchart');
    expect(issues.map((i) => i.path)).toContain('authoring');
    expect(checkStandardDefinition(rules({ elementKinds: [KIND], authoring: { shapes: 'none', icons: 'none' } }), 'flowchart')).toEqual([]);
  });
});
