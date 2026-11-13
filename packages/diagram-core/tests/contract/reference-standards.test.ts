import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DiagramModel } from '../../src/model/diagram-model.js';
import { addEdge } from '../../src/model/diagram-ops.js';
import { addElementOfKind, applyConnectorRule } from '../../src/model/standard-ops.js';
import { getDslFamily } from '../../src/dsl/registry.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { checkStandardDefinition } from '../../src/standards/definition-check.js';
import type { StandardRules } from '../../src/standards/schema.js';
import { validate } from '../../src/standards/validator.js';
import { VALUE_CHAIN_STANDARD } from '../../src/standards/reference/value-chain.js';
import { VALUE_STREAM_STANDARD } from '../../src/standards/reference/value-stream.js';

// canvas-keg8: the reference standards exported for consumers (ADP). A diagram built only from a
// standard's own kinds and connector rules must be compliant -- and still compliant after a round
// trip through the flowchart DSL, because the DSL text is what consumers store.

const empty = (): DiagramModel => ({ diagramTypeId: 'flowchart', direction: 'LR', nodes: [], edges: [], containers: [] });

const kindOf = (rules: StandardRules, id: string) => rules.elementKinds!.find((k) => k.id === id)!;
const ruleOf = (rules: StandardRules, id: string) => rules.connectorRules!.find((r) => r.id === id)!;

function connect(model: DiagramModel, rules: StandardRules, ruleId: string, sourceId: string, targetId: string): DiagramModel {
  const next = addEdge(model, { sourceId, targetId });
  return applyConnectorRule(next, next.edges[next.edges.length - 1].id, ruleOf(rules, ruleId));
}

function add(model: DiagramModel, rules: StandardRules, kindId: string, label: string) {
  return addElementOfKind(model, kindOf(rules, kindId), { label, rules });
}

function roundTrip(model: DiagramModel): DiagramModel {
  const family = getDslFamily('flowchart')!;
  const parsed = family.parse(family.serialize(model));
  if (!isParseSuccess(parsed)) throw new Error(`round trip failed to parse: ${JSON.stringify(parsed)}`);
  return parsed.model;
}

function valueChain(primaries: string[], supports: string[]): DiagramModel {
  const rules = VALUE_CHAIN_STANDARD;
  let model = empty();
  const primaryIds: string[] = [];
  for (const label of primaries) {
    const added = add(model, rules, 'primary_activity', label);
    model = added.model;
    primaryIds.push(added.nodeId);
  }
  for (const label of supports) model = add(model, rules, 'support_activity', label).model;
  const margin = add(model, rules, 'margin', 'Margin');
  model = margin.model;
  for (let i = 1; i < primaryIds.length; i++) model = connect(model, rules, 'flow', primaryIds[i - 1], primaryIds[i]);
  return connect(model, rules, 'to_margin', primaryIds[primaryIds.length - 1], margin.nodeId);
}

function valueStream(stages: { name: string; capabilities: string[] }[], stakeholder?: string): DiagramModel {
  const rules = VALUE_STREAM_STANDARD;
  let model = empty();
  const stageIds: string[] = [];
  for (const stage of stages) {
    const added = add(model, rules, 'value_stage', stage.name);
    model = added.model;
    stageIds.push(added.nodeId);
    for (const cap of stage.capabilities) {
      const capNode = add(model, rules, 'enabling_capability', cap);
      model = connect(capNode.model, rules, 'enabled_by', added.nodeId, capNode.nodeId);
    }
  }
  for (let i = 1; i < stageIds.length; i++) model = connect(model, rules, 'stage_flow', stageIds[i - 1], stageIds[i]);
  if (stakeholder) {
    const s = add(model, rules, 'stakeholder', stakeholder);
    model = connect(s.model, rules, 'triggers', s.nodeId, stageIds[0]);
  }
  return model;
}

describe.each([
  ['VALUE_CHAIN_STANDARD', VALUE_CHAIN_STANDARD],
  ['VALUE_STREAM_STANDARD', VALUE_STREAM_STANDARD],
])('%s definition', (_name, rules) => {
  it('is a coherent flowchart standard', () => {
    expect(checkStandardDefinition(rules, 'flowchart')).toEqual([]);
  });
});

describe('VALUE_CHAIN_STANDARD', () => {
  const porter = () =>
    valueChain(
      ['Inbound Logistics', 'Operations', 'Outbound Logistics', 'Marketing & Sales', 'Service'],
      ['Firm Infrastructure', 'HR Management', 'Technology Development', 'Procurement'],
    );

  it("accepts Porter's chain built from its own kinds", () => {
    expect(validate(porter(), VALUE_CHAIN_STANDARD)).toEqual([]);
  });

  it('stays compliant after a round trip through the flowchart DSL', () => {
    expect(validate(roundTrip(porter()), VALUE_CHAIN_STANDARD)).toEqual([]);
  });

  it('flags a chain with no margin', () => {
    const model = porter();
    const marginId = model.nodes.find((n) => n.role === 'margin')!.id;
    const noMargin = { ...model, nodes: model.nodes.filter((n) => n.id !== marginId), edges: model.edges.filter((e) => e.targetId !== marginId) };
    expect(validate(noMargin, VALUE_CHAIN_STANDARD).map((v) => v.rule)).toContain('kind-min-count');
  });

  it('flags a connector into a support activity', () => {
    const model = porter();
    const primary = model.nodes.find((n) => n.role === 'primary_activity')!.id;
    const support = model.nodes.find((n) => n.role === 'support_activity')!.id;
    const bad = addEdge(model, { sourceId: primary, targetId: support });
    expect(validate(bad, VALUE_CHAIN_STANDARD).map((v) => v.rule)).toContain('connector-not-allowed');
  });
});

describe('VALUE_STREAM_STANDARD', () => {
  const stream = () =>
    valueStream(
      [
        { name: 'Order Placed', capabilities: ['Order Management'] },
        { name: 'Order Fulfilled', capabilities: ['Inventory Management', 'Warehouse Management'] },
        { name: 'Order Delivered', capabilities: [] },
      ],
      'Customer',
    );

  it('accepts a stream built from its own kinds', () => {
    expect(validate(stream(), VALUE_STREAM_STANDARD)).toEqual([]);
  });

  it('stays compliant after a round trip through the flowchart DSL', () => {
    expect(validate(roundTrip(stream()), VALUE_STREAM_STANDARD)).toEqual([]);
  });

  it('accepts a single stage with no stakeholder', () => {
    expect(validate(valueStream([{ name: 'Value Delivered', capabilities: [] }]), VALUE_STREAM_STANDARD)).toEqual([]);
  });

  it('flags a second stakeholder', () => {
    const model = stream();
    const extra = add(model, VALUE_STREAM_STANDARD, 'stakeholder', 'Partner').model;
    expect(validate(extra, VALUE_STREAM_STANDARD).map((v) => v.rule)).toContain('kind-max-count');
  });

  it('flags a stage that branches to two next stages', () => {
    let model = stream();
    const [a, , c] = model.nodes.filter((n) => n.role === 'value_stage').map((n) => n.id);
    model = connect(model, VALUE_STREAM_STANDARD, 'stage_flow', a, c);
    expect(validate(model, VALUE_STREAM_STANDARD).map((v) => v.rule)).toContain('connector-max-per-source');
  });
});

// The API seeds VALUE_CHAIN_STANDARD as a Python dict (apps/api-py/src/canvas_api/seed/reference_standards.py).
// This fixture is the contract between the two: this test pins the TypeScript export to it, and the API's
// tests/test_reference_standards_parity.py pins the Python dict to it. Regenerate after a deliberate change:
//   node -e "import('./dist/index.js').then(m => require('fs').writeFileSync(
//     'tests/fixtures/reference-standards/value-chain.json', JSON.stringify(m.VALUE_CHAIN_STANDARD, null, 2) + '\\n'))"
describe('VALUE_CHAIN_STANDARD fixture', () => {
  it('matches the fixture the API seed is checked against, key order included', () => {
    const fixture = readFileSync(new URL('../fixtures/reference-standards/value-chain.json', import.meta.url), 'utf8');
    expect(JSON.stringify(VALUE_CHAIN_STANDARD, null, 2) + '\n').toBe(fixture);
  });
});
