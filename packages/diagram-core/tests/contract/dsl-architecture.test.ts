import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
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
  const dsl = serializeArchitecture(model);
  const result = parseArchitecture(dsl);
  if (!isParseSuccess(result)) {
    throw new Error(`Expected successful round-trip parse, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.model;
}

describe('architecture (cloud-infrastructure) DSL family', () => {
  it('round-trips services with vendor icon references and a group', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        {
          id: 'fn1',
          label: 'Order Processor',
          shape: 'icon',
          position: { x: 0, y: 0 },
          containerId: 'vpc1',
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'lambda' },
        },
        {
          id: 'db1',
          label: 'Orders Table',
          shape: 'icon',
          position: { x: 200, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'dynamodb' },
        },
      ],
      edges: [{ id: 'e1', sourceId: 'fn1', targetId: 'db1' }],
      containers: [{ id: 'vpc1', label: 'VPC', position: { x: -20, y: -20 }, size: { width: 300, height: 200 } }],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('round-trips a mix of Azure and AWS icon references', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        {
          id: 'blob1',
          label: 'Storage',
          shape: 'icon',
          position: { x: 0, y: 0 },
          icon: { libraryId: 'azure-icons', libraryVersion: '2024.1', iconId: 'storage-accounts' },
        },
        {
          id: 's3',
          label: 'Bucket',
          shape: 'icon',
          position: { x: 200, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 's3' },
        },
      ],
      edges: [],
      containers: [],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('reports a structured error for unrecognized architecture syntax', () => {
    const result = parseArchitecture('architecture-beta\n???not-valid???\n');
    expect(isParseSuccess(result)).toBe(false);
  });
});
