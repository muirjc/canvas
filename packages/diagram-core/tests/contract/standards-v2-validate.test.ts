import { describe, expect, it } from 'vitest';
import { validate } from '../../src/standards/validator.js';
import { emptyStandardRules, type ConnectorRule, type ElementKind, type StandardRules } from '../../src/standards/schema.js';
import type { DiagramEdge, DiagramModel, DiagramNode } from '../../src/model/diagram-model.js';

// canvas-tfr: Standards v2 validation contract (element kinds, connector rules, containers).

function node(id: string, over: Partial<DiagramNode> = {}): DiagramNode {
  return { id, label: id, shape: 'rectangle', position: { x: 0, y: 0 }, ...over };
}
function edge(id: string, sourceId: string, targetId: string, over: Partial<DiagramEdge> = {}): DiagramEdge {
  return { id, sourceId, targetId, ...over };
}
function model(nodes: DiagramNode[], edges: DiagramEdge[] = [], over: Partial<DiagramModel> = {}): DiagramModel {
  return { diagramTypeId: 'flowchart', nodes, edges, containers: [], ...over };
}
function kind(id: string, over: Partial<ElementKind> = {}): ElementKind {
  return { id, label: id, shapes: [], approvedFills: [], ...over };
}
function rules(over: Partial<StandardRules>): StandardRules {
  return { ...emptyStandardRules(), ...over };
}
function ruleViolations(m: DiagramModel, r: StandardRules, ruleId: string) {
  return validate(m, r).filter((v) => v.rule === ruleId);
}
function connector(over: Partial<ConnectorRule> & { id: string }): ConnectorRule {
  return { label: over.id, from: '*', to: '*', ...over };
}

describe('validate v2: unknown-kind', () => {
  const m = model([node('A', { role: 'primary' }), node('B', { role: 'mystery' })]);

  it('flags a node whose role matches no kind when requireKnownKinds is set', () => {
    const v = ruleViolations(m, rules({ elementKinds: [kind('primary')], requireKnownKinds: true }), 'unknown-kind');
    expect(v).toEqual([expect.objectContaining({ elementId: 'B', severity: 'error', elementType: 'node' })]);
  });

  it('does not flag when requireKnownKinds is false', () => {
    expect(ruleViolations(m, rules({ elementKinds: [kind('primary')], requireKnownKinds: false }), 'unknown-kind')).toEqual([]);
  });
});

describe('validate v2: kind-shape', () => {
  it('flags a node whose shape is not in its kind shapes (warning)', () => {
    const r = rules({ elementKinds: [kind('primary', { shapes: ['rounded-rectangle'] })] });
    const v = ruleViolations(model([node('A', { role: 'primary', shape: 'circle' })]), r, 'kind-shape');
    expect(v).toEqual([expect.objectContaining({ elementId: 'A', severity: 'warning', kindId: 'primary', elementType: 'node' })]);
  });

  it('accepts a listed shape', () => {
    const r = rules({ elementKinds: [kind('primary', { shapes: ['rounded-rectangle'] })] });
    expect(ruleViolations(model([node('A', { role: 'primary', shape: 'rounded-rectangle' })]), r, 'kind-shape')).toEqual([]);
  });

  it('treats an empty shapes list as any shape', () => {
    const r = rules({ elementKinds: [kind('primary')] });
    expect(ruleViolations(model([node('A', { role: 'primary', shape: 'hexagon' })]), r, 'kind-shape')).toEqual([]);
  });
});

describe('validate v2: kind-fill (effective rendered fill)', () => {
  const r = rules({ elementKinds: [kind('primary', { approvedFills: ['#dbeafe'] })] });

  it('flags a flowchart node with no explicit fill because it renders #ffffff', () => {
    for (const diagramTypeId of ['flowchart', 'value-chain']) {
      const v = ruleViolations(model([node('A', { role: 'primary' })], [], { diagramTypeId }), r, 'kind-fill');
      expect(v).toEqual([expect.objectContaining({ elementId: 'A', severity: 'warning', kindId: 'primary' })]);
    }
  });

  it('compares case-insensitively', () => {
    const m = model([node('A', { role: 'primary', style: { fillColor: '#DBEAFE' } })]);
    expect(ruleViolations(m, r, 'kind-fill')).toEqual([]);
  });

  it('flags an explicit fill outside the approved list', () => {
    const m = model([node('A', { role: 'primary', style: { fillColor: '#ff0000' } })]);
    expect(ruleViolations(m, r, 'kind-fill')).toHaveLength(1);
  });

  it('is unconstrained when approvedFills is empty', () => {
    const m = model([node('A', { role: 'primary' })]);
    expect(ruleViolations(m, rules({ elementKinds: [kind('primary')] }), 'kind-fill')).toEqual([]);
  });

  it('passes a C4 system with no fill when the approved fill is the C4 default #1168bd', () => {
    const rr = rules({ elementKinds: [kind('system', { approvedFills: ['#1168bd'] })] });
    const m = model([node('S', { role: 'system' })], [], { diagramTypeId: 'c4-context' });
    expect(ruleViolations(m, rr, 'kind-fill')).toEqual([]);
  });

  it('uses the external C4 greys: system #999999, person #686868', () => {
    const sys = rules({ elementKinds: [kind('ext_system', { match: { role: 'system', external: true }, approvedFills: ['#999999'] })] });
    const ms = model([node('S', { role: 'system', external: true })], [], { diagramTypeId: 'c4-context' });
    expect(ruleViolations(ms, sys, 'kind-fill')).toEqual([]);

    const per = rules({ elementKinds: [kind('ext_person', { match: { role: 'person', external: true }, approvedFills: ['#686868'] })] });
    const mp = model([node('P', { role: 'person', shape: 'person', external: true })], [], { diagramTypeId: 'c4-context' });
    expect(ruleViolations(mp, per, 'kind-fill')).toEqual([]);

    // a non-external person is not classified as ext_person, so kind-fill does not apply to it
    const mp2 = model([node('P', { role: 'person', shape: 'person' })], [], { diagramTypeId: 'c4-context' });
    expect(ruleViolations(mp2, per, 'kind-fill')).toEqual([]);
  });
});

describe('validate v2: kind-stroke', () => {
  const r = rules({ elementKinds: [kind('primary', { approvedStrokes: ['#1e3a8a'] })] });

  it('flags an effective stroke outside approvedStrokes as info (flowchart default #333333)', () => {
    const v = ruleViolations(model([node('A', { role: 'primary' })]), r, 'kind-stroke');
    expect(v).toEqual([expect.objectContaining({ elementId: 'A', severity: 'info', kindId: 'primary' })]);
  });

  it('accepts an approved explicit stroke, case-insensitively', () => {
    const m = model([node('A', { role: 'primary', style: { strokeColor: '#1E3A8A' } })]);
    expect(ruleViolations(m, r, 'kind-stroke')).toEqual([]);
  });
});

describe('validate v2: kind counts', () => {
  it('flags too few elements of a kind (kind-min-count, error, diagram-level)', () => {
    const r = rules({ elementKinds: [kind('primary', { minCount: 2 })] });
    const v = ruleViolations(model([node('A', { role: 'primary' })]), r, 'kind-min-count');
    expect(v).toEqual([expect.objectContaining({ elementId: '(diagram)', elementType: 'diagram', severity: 'error', kindId: 'primary' })]);
  });

  it('flags too many elements of a kind (kind-max-count)', () => {
    const r = rules({ elementKinds: [kind('primary', { maxCount: 1 })] });
    const m = model([node('A', { role: 'primary' }), node('B', { role: 'primary' })]);
    const v = ruleViolations(m, r, 'kind-max-count');
    expect(v).toEqual([expect.objectContaining({ elementId: '(diagram)', elementType: 'diagram', severity: 'error', kindId: 'primary' })]);
  });

  it('passes when counts are within bounds', () => {
    const r = rules({ elementKinds: [kind('primary', { minCount: 1, maxCount: 2 })] });
    const m = model([node('A', { role: 'primary' }), node('B', { role: 'primary' })]);
    expect(validate(m, r).filter((v) => v.rule.startsWith('kind-m'))).toEqual([]);
  });
});

describe('validate v2: kind-unconnected', () => {
  const r = rules({ elementKinds: [kind('primary', { requireConnection: true })] });

  it('flags an element with no incident edge (info)', () => {
    const v = ruleViolations(model([node('A', { role: 'primary' })]), r, 'kind-unconnected');
    expect(v).toEqual([expect.objectContaining({ elementId: 'A', severity: 'info', kindId: 'primary' })]);
  });

  it('counts an edge as incident whether the node is its source or its target', () => {
    const m = model(
      [node('A', { role: 'primary' }), node('B', { role: 'primary' }), node('C')],
      [edge('e1', 'A', 'C'), edge('e2', 'C', 'B')],
    );
    expect(ruleViolations(m, r, 'kind-unconnected')).toEqual([]);
  });
});

describe('validate v2: connectors', () => {
  const kinds = [kind('primary'), kind('support')];
  const m = model(
    [node('A', { role: 'primary' }), node('B', { role: 'support' })],
    [edge('e1', 'A', 'B')],
  );

  it("listed-only: an edge with no matching rule is connector-not-allowed (error, edge)", () => {
    const r = rules({ elementKinds: kinds, connectorPolicy: 'listed-only', connectorRules: [connector({ id: 'x', from: 'support', to: 'primary' })] });
    const v = ruleViolations(m, r, 'connector-not-allowed');
    expect(v).toEqual([expect.objectContaining({ elementId: 'e1', elementType: 'edge', severity: 'error' })]);
  });

  it('listed-only: a matching rule allows the edge', () => {
    const r = rules({ elementKinds: kinds, connectorPolicy: 'listed-only', connectorRules: [connector({ id: 'x', from: 'primary', to: 'support' })] });
    expect(ruleViolations(m, r, 'connector-not-allowed')).toEqual([]);
  });

  it("'*' wildcards match any kind", () => {
    const r = rules({ elementKinds: kinds, connectorPolicy: 'listed-only', connectorRules: [connector({ id: 'any' })] });
    expect(ruleViolations(m, r, 'connector-not-allowed')).toEqual([]);
    const r2 = rules({ elementKinds: kinds, connectorPolicy: 'listed-only', connectorRules: [connector({ id: 'fromP', from: 'primary', to: '*' })] });
    expect(ruleViolations(m, r2, 'connector-not-allowed')).toEqual([]);
  });

  it("policy 'any' or absent: no rule match is not a violation", () => {
    expect(ruleViolations(m, rules({ elementKinds: kinds, connectorPolicy: 'any', connectorRules: [] }), 'connector-not-allowed')).toEqual([]);
    expect(ruleViolations(m, rules({ elementKinds: kinds }), 'connector-not-allowed')).toEqual([]);
  });

  describe('connector-style', () => {
    it('flags a line style outside the rule (info)', () => {
      const mm = model([node('A', { role: 'primary' }), node('B', { role: 'support' })], [edge('e1', 'A', 'B', { lineStyle: 'dotted' })]);
      const r = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', lineStyles: ['solid'] })] });
      expect(ruleViolations(mm, r, 'connector-style')).toEqual([expect.objectContaining({ elementId: 'e1', severity: 'info', elementType: 'edge' })]);
    });

    it("treats an absent lineStyle as 'solid'", () => {
      const solidOnly = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', lineStyles: ['solid'] })] });
      expect(ruleViolations(m, solidOnly, 'connector-style')).toEqual([]);
      const dottedOnly = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', lineStyles: ['dotted'] })] });
      expect(ruleViolations(m, dottedOnly, 'connector-style')).toHaveLength(1);
    });

    it("treats an absent arrow as 'target'", () => {
      const targetOnly = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', arrows: ['target'] })] });
      expect(ruleViolations(m, targetOnly, 'connector-style')).toEqual([]);
      const noneOnly = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', arrows: ['none'] })] });
      expect(ruleViolations(m, noneOnly, 'connector-style')).toHaveLength(1);
    });

    it('flags an explicit arrow outside the rule', () => {
      const mm = model([node('A', { role: 'primary' }), node('B', { role: 'support' })], [edge('e1', 'A', 'B', { arrow: 'both' })]);
      const r = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', arrows: ['target'] })] });
      expect(ruleViolations(mm, r, 'connector-style')).toHaveLength(1);
    });
  });

  describe('connector-label-required', () => {
    const r = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', requireLabel: true })] });

    it.each([[undefined], ['   ']])('flags a missing/blank label (%j)', (label) => {
      const mm = model([node('A', { role: 'primary' }), node('B', { role: 'support' })], [edge('e1', 'A', 'B', { label })]);
      expect(ruleViolations(mm, r, 'connector-label-required')).toEqual([expect.objectContaining({ elementId: 'e1', severity: 'warning', elementType: 'edge' })]);
    });

    it('passes with a label', () => {
      const mm = model([node('A', { role: 'primary' }), node('B', { role: 'support' })], [edge('e1', 'A', 'B', { label: 'feeds' })]);
      expect(ruleViolations(mm, r, 'connector-label-required')).toEqual([]);
    });
  });

  describe('connector-max-per-source', () => {
    it('flags the excess edges from a single source', () => {
      const mm = model(
        [node('A', { role: 'primary' }), node('B', { role: 'support' }), node('C', { role: 'support' }), node('D', { role: 'support' })],
        [edge('e1', 'A', 'B'), edge('e2', 'A', 'C'), edge('e3', 'A', 'D')],
      );
      const r = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', maxPerSource: 1 })] });
      const v = ruleViolations(mm, r, 'connector-max-per-source');
      expect(v.map((x) => x.elementId).sort()).toEqual(['e2', 'e3']);
      expect(v.every((x) => x.severity === 'warning' && x.elementType === 'edge')).toBe(true);
    });

    it('does not flag edges from different sources', () => {
      const mm = model(
        [node('A', { role: 'primary' }), node('A2', { role: 'primary' }), node('B', { role: 'support' })],
        [edge('e1', 'A', 'B'), edge('e2', 'A2', 'B')],
      );
      const r = rules({ elementKinds: kinds, connectorRules: [connector({ id: 'x', from: 'primary', to: 'support', maxPerSource: 1 })] });
      expect(ruleViolations(mm, r, 'connector-max-per-source')).toEqual([]);
    });
  });
});

describe('validate v2: container-not-allowed', () => {
  const withContainer = (role?: string) =>
    model([node('A')], [], { containers: [{ id: 'c1', label: 'C', position: { x: 0, y: 0 }, role }] });

  it('flags any container when containers.allowed is false (warning)', () => {
    const v = ruleViolations(withContainer(), rules({ containers: { allowed: false } }), 'container-not-allowed');
    expect(v).toEqual([expect.objectContaining({ elementId: 'c1', elementType: 'container', severity: 'warning' })]);
  });

  it('flags a container whose role is not in allowedRoles', () => {
    const r = rules({ containers: { allowed: true, allowedRoles: ['system-boundary'] } });
    expect(ruleViolations(withContainer('deployment-node'), r, 'container-not-allowed')).toHaveLength(1);
    expect(ruleViolations(withContainer('system-boundary'), r, 'container-not-allowed')).toEqual([]);
  });

  it('allows containers when allowed is true and no role list is set', () => {
    expect(ruleViolations(withContainer(), rules({ containers: { allowed: true } }), 'container-not-allowed')).toEqual([]);
  });
});

describe('validate v2: severityOverrides', () => {
  it('overrides the default severity of a rule', () => {
    const r = rules({ elementKinds: [kind('primary', { approvedFills: ['#dbeafe'] })], severityOverrides: { 'kind-fill': 'error' } });
    const v = ruleViolations(model([node('A', { role: 'primary' })]), r, 'kind-fill');
    expect(v).toEqual([expect.objectContaining({ severity: 'error' })]);
  });
});

describe('validate: v1 and v2 together', () => {
  it('still produces v1 violations (warning) alongside v2 ones', () => {
    const m = model([node('A', { role: 'primary', shape: 'circle', style: { fillColor: '#ff0000' } })]);
    const r = rules({
      allowedShapeIds: ['rectangle'],
      colorPalette: [{ role: 'primary', colorHex: '#00ff00' }],
      elementKinds: [kind('primary', { approvedFills: ['#dbeafe'] })],
    });
    const v = validate(m, r);
    expect(v).toContainEqual(expect.objectContaining({ rule: 'allowed-shapes', severity: 'warning', elementId: 'A' }));
    expect(v).toContainEqual(expect.objectContaining({ rule: 'color-palette', severity: 'warning', elementId: 'A' }));
    expect(v).toContainEqual(expect.objectContaining({ rule: 'kind-fill', elementId: 'A' }));
  });

  it('a rules object with no v2 fields produces exactly the v1 result', () => {
    const m: DiagramModel = {
      diagramTypeId: 'c4-context',
      nodes: [
        { id: 'p1', label: 'Customer', shape: 'person', role: 'person', position: { x: 0, y: 0 }, style: { fillColor: '#08427b' } },
        { id: 's1', label: 'System', shape: 'rectangle', role: 'system', position: { x: 200, y: 0 } },
      ],
      edges: [],
      containers: [],
    };
    const v = validate(m, rules({ allowedShapeIds: ['person'] }));
    expect(v).toEqual([
      expect.objectContaining({ elementId: 's1', rule: 'allowed-shapes', severity: 'warning' }),
    ]);
    expect(validate(m, emptyStandardRules())).toEqual([]);
  });
});
