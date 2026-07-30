import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * Constitution I (Diagram-as-Data): parse(serialize(model)) must reconstruct a model equal to
 * the input for every diagram expressible in the editor. This is the primary property test
 * required before any diagram-type or export implementation work begins (Constitution IV).
 */
function normalize(model: DiagramModel) {
  return {
    diagramTypeId: model.diagramTypeId,
    nodes: [...model.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...model.edges].sort((a, b) => a.id.localeCompare(b.id)),
    containers: [...model.containers].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function roundTrip(model: DiagramModel): DiagramModel {
  const dsl = serializeFlowchart(model);
  const result = parseFlowchart(dsl);
  if (!isParseSuccess(result)) {
    throw new Error(`Expected successful round-trip parse, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.model;
}

describe('flowchart round-trip (parse(serialize(model)) === model)', () => {
  it('round-trips a simple three-node, two-edge diagram', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'Start', shape: 'rectangle', position: { x: 40, y: 40 } },
        { id: 'B', label: 'Decision', shape: 'diamond', position: { x: 240, y: 40 } },
        { id: 'C', label: 'End', shape: 'rounded-rectangle', position: { x: 440, y: 40 } },
      ],
      edges: [
        { id: 'e1', sourceId: 'A', targetId: 'B' },
        { id: 'e2', sourceId: 'B', targetId: 'C', label: 'yes' },
      ],
      containers: [],
    };

    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('round-trips containers/groupings with nested nodes', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'Inside', shape: 'rectangle', position: { x: 60, y: 60 }, containerId: 'grp1' },
        { id: 'B', label: 'Outside', shape: 'circle', position: { x: 400, y: 60 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B' }],
      containers: [
        { id: 'grp1', label: 'Group One', position: { x: 20, y: 20 }, size: { width: 200, height: 150 } },
      ],
    };

    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('preserves node style and icon metadata through the front-matter block', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        {
          id: 'A',
          label: 'Styled',
          shape: 'cylinder',
          position: { x: 10, y: 10 },
          style: { fillColor: '#1168bd', strokeColor: '#0b4884', fontSize: 16 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'lambda' },
        },
      ],
      edges: [],
      containers: [],
    };

    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('is stable across repeated round-trips (idempotent serialize/parse)', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'One', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'Two', shape: 'rectangle', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', label: 'next' }],
      containers: [],
    };

    let current = model;
    for (let i = 0; i < 5; i += 1) {
      current = roundTrip(current);
    }
    expect(normalize(current)).toEqual(normalize(model));
  });

  const newShapes: DiagramModel['nodes'][number]['shape'][] = [
    'stadium',
    'subroutine',
    'double-circle',
    'hexagon',
    'parallelogram',
    'parallelogram-alt',
    'trapezoid',
    'trapezoid-alt',
    'asymmetric',
  ];

  it.each(newShapes)('round-trips a %s node losslessly', (shape) => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: 'Node', shape, position: { x: 40, y: 40 } }],
      edges: [],
      containers: [],
    };

    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('never normalizes parallelogram/trapezoid to their -alt counterpart or vice versa', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'P', shape: 'parallelogram', position: { x: 0, y: 0 } },
        { id: 'B', label: 'PAlt', shape: 'parallelogram-alt', position: { x: 200, y: 0 } },
        { id: 'C', label: 'T', shape: 'trapezoid', position: { x: 400, y: 0 } },
        { id: 'D', label: 'TAlt', shape: 'trapezoid-alt', position: { x: 600, y: 0 } },
      ],
      edges: [],
      containers: [],
    };

    const result = roundTrip(model);
    expect(result.nodes.find((n) => n.id === 'A')!.shape).toBe('parallelogram');
    expect(result.nodes.find((n) => n.id === 'B')!.shape).toBe('parallelogram-alt');
    expect(result.nodes.find((n) => n.id === 'C')!.shape).toBe('trapezoid');
    expect(result.nodes.find((n) => n.id === 'D')!.shape).toBe('trapezoid-alt');
  });

  it('round-trips an edge style (linkStyle: color, width, dasharray) losslessly', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'Start', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'End', shape: 'rectangle', position: { x: 200, y: 0 } },
      ],
      edges: [
        {
          id: 'e1',
          sourceId: 'A',
          targetId: 'B',
          style: { strokeColor: '#ff0000', strokeWidth: 4, strokeDasharray: '5 5' },
        },
      ],
      containers: [],
    };

    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('round-trips distinct styles on multiple edges without cross-contamination', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } },
        { id: 'C', label: 'C', shape: 'rectangle', position: { x: 400, y: 0 } },
      ],
      edges: [
        { id: 'e1', sourceId: 'A', targetId: 'B', style: { strokeColor: '#ff0000' } },
        { id: 'e2', sourceId: 'B', targetId: 'C', style: { strokeDasharray: '2 2' } },
      ],
      containers: [],
    };

    const result = roundTrip(model);
    expect(result.edges.find((e) => e.id === 'e1')!.style?.strokeColor).toBe('#ff0000');
    expect(result.edges.find((e) => e.id === 'e1')!.style?.strokeDasharray).toBeUndefined();
    expect(result.edges.find((e) => e.id === 'e2')!.style?.strokeDasharray).toBe('2 2');
    expect(result.edges.find((e) => e.id === 'e2')!.style?.strokeColor).toBeUndefined();
  });
});
