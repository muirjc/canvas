import { describe, expect, it } from 'vitest';
import { parseFlowchart } from '../../src/dsl/flowchart-parser.js';
import { serializeFlowchart } from '../../src/dsl/flowchart-serializer.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import { addContainer, assignNodeToContainer } from '../../src/model/diagram-ops.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * Feature 006, User Story 2: containers must survive a save/reload cycle intact.
 *
 * Constitution Principle I forbids silent loss on round-trip. The case most likely to break it is
 * a container holding no nodes: the flowchart serializer writes container geometry with
 * `.filter((c) => c.size)`, so a container written without a size is omitted from front-matter
 * entirely and its position is replaced by an auto-position on the next parse. Every operation
 * that creates a container must therefore leave a size present
 * (specs/006-authoring-admin-console/data-model.md invariant 1).
 */
function roundTrip(model: DiagramModel): DiagramModel {
  const result = parseFlowchart(serializeFlowchart(model));
  if (!isParseSuccess(result)) {
    throw new Error(`round-trip failed to parse: ${JSON.stringify(result.errors)}`);
  }
  return result.model;
}

function modelWithContainer(): DiagramModel {
  return {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'a', label: 'Validate', shape: 'rectangle', position: { x: 60, y: 60 }, containerId: 'dom' },
      { id: 'b', label: 'Approve', shape: 'rectangle', position: { x: 240, y: 60 }, containerId: 'dom' },
      { id: 'c', label: 'Outside', shape: 'rectangle', position: { x: 500, y: 300 } },
    ],
    edges: [{ id: 'e1', sourceId: 'a', targetId: 'b' }],
    containers: [
      { id: 'dom', label: 'Payments Domain', position: { x: 20, y: 20 }, size: { width: 400, height: 200 } },
    ],
  };
}

describe('container round-trip', () => {
  it('preserves id, label, position, and size', () => {
    const before = modelWithContainer();
    const after = roundTrip(before);
    const container = after.containers.find((c) => c.id === 'dom');
    expect(container).toBeDefined();
    expect(container!.label).toBe('Payments Domain');
    expect(container!.position).toEqual({ x: 20, y: 20 });
    expect(container!.size).toEqual({ width: 400, height: 200 });
  });

  it('preserves node membership', () => {
    const after = roundTrip(modelWithContainer());
    expect(after.nodes.find((n) => n.id === 'a')!.containerId).toBe('dom');
    expect(after.nodes.find((n) => n.id === 'b')!.containerId).toBe('dom');
    expect(after.nodes.find((n) => n.id === 'c')!.containerId).toBeUndefined();
  });

  it('preserves a container holding NO nodes, including its position', () => {
    // The trap. An empty container is the only case where nothing else in the DSL implies the
    // container exists, so it survives solely on its front-matter geometry entry.
    const before = addContainer(modelWithContainer(), {
      label: 'Empty Region',
      position: { x: 700, y: 400 },
    });
    const emptyId = before.containers.at(-1)!.id;

    const after = roundTrip(before);
    const empty = after.containers.find((c) => c.id === emptyId);
    expect(empty, 'an empty container was dropped on round-trip').toBeDefined();
    expect(empty!.position).toEqual({ x: 700, y: 400 });
    expect(empty!.label).toBe('Empty Region');
  });

  it('preserves nested container structure', () => {
    // Creating nesting is out of scope for this feature, but imported diagrams may already
    // contain it and must not be degraded (FR-016a).
    const before: DiagramModel = {
      ...modelWithContainer(),
      containers: [
        { id: 'outer', label: 'Outer', position: { x: 0, y: 0 }, size: { width: 600, height: 400 } },
        {
          id: 'inner',
          label: 'Inner',
          position: { x: 40, y: 40 },
          size: { width: 200, height: 150 },
          parentContainerId: 'outer',
        },
      ],
      nodes: [
        { id: 'a', label: 'A', shape: 'rectangle', position: { x: 60, y: 60 }, containerId: 'inner' },
        { id: 'b', label: 'B', shape: 'rectangle', position: { x: 300, y: 60 }, containerId: 'outer' },
      ],
    };

    const after = roundTrip(before);
    expect(after.containers.find((c) => c.id === 'inner')!.parentContainerId).toBe('outer');
    expect(after.nodes.find((n) => n.id === 'a')!.containerId).toBe('inner');
    expect(after.nodes.find((n) => n.id === 'b')!.containerId).toBe('outer');
  });

  it('survives a model built purely through the container operations', () => {
    const built = assignNodeToContainer(
      addContainer(
        {
          diagramTypeId: 'flowchart',
          nodes: [{ id: 'n1', label: 'Step', shape: 'rectangle', position: { x: 80, y: 80 } }],
          edges: [],
          containers: [],
        },
        { label: 'Built' },
      ),
      'n1',
      // the container just added is the only one present
      'placeholder',
    );
    // Resolve the generated id and assign properly.
    const containerId = built.containers[0].id;
    const model = assignNodeToContainer(built, 'n1', containerId);

    const after = roundTrip(model);
    expect(after.containers).toHaveLength(1);
    expect(after.containers[0].label).toBe('Built');
    expect(after.containers[0].size).toBeDefined();
    expect(after.nodes[0].containerId).toBe(containerId);
  });
});
