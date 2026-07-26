import { describe, expect, it } from 'vitest';
import { parseC4 } from '../../src/dsl/c4.js';
import { serializeC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

function normalize(model: DiagramModel) {
  return {
    diagramTypeId: model.diagramTypeId,
    nodes: [...model.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...model.edges].sort((a, b) => a.id.localeCompare(b.id)),
    containers: [...model.containers].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function roundTrip(model: DiagramModel): DiagramModel {
  const dsl = serializeC4(model);
  const result = parseC4(dsl);
  if (!isParseSuccess(result)) {
    throw new Error(`Expected successful round-trip parse, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.model;
}

describe('C4 DSL family (Context/Container/Component/Code)', () => {
  it('round-trips a C4 Context diagram with Person, System, and a Rel', () => {
    const model: DiagramModel = {
      diagramTypeId: 'c4-context',
      nodes: [
        { id: 'customer', label: 'Customer', shape: 'person', role: 'person', position: { x: 0, y: 0 } },
        { id: 'system', label: 'Our System', shape: 'rectangle', role: 'system', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'customer', targetId: 'system', label: 'Uses' }],
      containers: [],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('round-trips a C4 Container diagram with a System_Boundary grouping', () => {
    const model: DiagramModel = {
      diagramTypeId: 'c4-container',
      nodes: [
        { id: 'web', label: 'Web App', shape: 'rounded-rectangle', role: 'container', position: { x: 0, y: 0 }, containerId: 'b1' },
        { id: 'db', label: 'Database', shape: 'cylinder', role: 'system', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'web', targetId: 'db', label: 'Reads/Writes' }],
      containers: [{ id: 'b1', label: 'Our System', position: { x: 0, y: 0 } }],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('preserves diagram level (Context vs Container vs Component vs Code) through round-trip', () => {
    for (const level of ['c4-context', 'c4-container', 'c4-component', 'c4-code']) {
      const model: DiagramModel = {
        diagramTypeId: level,
        nodes: [{ id: 'a', label: 'A', shape: 'rectangle', role: 'system', position: { x: 0, y: 0 } }],
        edges: [],
        containers: [],
      };
      expect(roundTrip(model).diagramTypeId).toBe(level);
    }
  });

  it('reports a structured error for unrecognized C4 syntax', () => {
    const result = parseC4('C4Context\n???not-valid???\n');
    expect(isParseSuccess(result)).toBe(false);
  });
});
