import { beforeEach, describe, expect, it } from 'vitest';
import { createDiagramTools, type DiagramTools } from '../../src/ai/diagram-tools.js';
import type { DiagramModel } from '@canvas/diagram-core';

/**
 * The AI tool wrappers (direct unit-style tests, no LLM involved) — moved here from
 * diagram-chat.test.ts as part of 010-ai-diagram-knowledge, whose T005 gave `createDiagramTools`
 * a required `family` parameter (the HTTP/wiring-level tests for the endpoint itself stay in
 * diagram-chat.test.ts). This file also covers T004: every one of the 6 registered families gets
 * the same 8 base tools, unchanged — a regression guard for the family-conditional tool surface
 * 010-ai-diagram-knowledge's later stories build on top of.
 */

const ALL_FAMILIES = ['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml'] as const;
const BASE_TOOL_NAMES = [
  'addNode',
  'removeNode',
  'addEdge',
  'removeEdge',
  'updateNodeLabel',
  'updateEdgeLabel',
  'updateNodeStyle',
  'updateEdgeStyle',
] as const;

/**
 * User Story 2 (T018): the 8 NEW family-conditional tools, per family they apply to. Every
 * family's tool set is exactly BASE_TOOL_NAMES plus whichever of these are listed below (and NONE
 * of the ones that aren't) — asserted both ways (toHaveProperty / not.toHaveProperty) so a tool
 * accidentally offered to the wrong family is caught, not just a missing one.
 */
const EXTRA_TOOL_NAMES = [
  'setNodeRole',
  'setEntityAttributes',
  'setClassMembers',
  'setRelationshipKind',
  'setConnectorStyle',
  'groupIntoContainer',
  'activateParticipant',
  'deactivateParticipant',
] as const;

const EXTRA_TOOLS_BY_FAMILY: Record<(typeof ALL_FAMILIES)[number], (typeof EXTRA_TOOL_NAMES)[number][]> = {
  flowchart: ['setConnectorStyle'],
  c4: ['setNodeRole', 'groupIntoContainer'],
  architecture: ['groupIntoContainer'],
  sequence: ['setNodeRole', 'setConnectorStyle', 'groupIntoContainer', 'activateParticipant', 'deactivateParticipant'],
  erd: ['setEntityAttributes'],
  uml: ['setClassMembers', 'setRelationshipKind', 'groupIntoContainer'],
};

describe('createDiagramTools — family-conditional availability (T004)', () => {
  it.each(ALL_FAMILIES)('returns the 8 base tools, unchanged, for family "%s"', (family) => {
    let model: DiagramModel = { diagramTypeId: family, nodes: [], edges: [], containers: [] };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, family);
    for (const name of BASE_TOOL_NAMES) {
      expect(tools).toHaveProperty(name);
    }
  });

  it.each(ALL_FAMILIES)('offers exactly the right set of the 8 new family-conditional tools for family "%s" (T018)', (family) => {
    let model: DiagramModel = { diagramTypeId: family, nodes: [], edges: [], containers: [] };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, family);
    const expectedExtras = EXTRA_TOOLS_BY_FAMILY[family];
    for (const name of EXTRA_TOOL_NAMES) {
      if (expectedExtras.includes(name)) {
        expect(tools).toHaveProperty(name);
      } else {
        expect(tools).not.toHaveProperty(name);
      }
    }
  });
});

describe('diagram-tools (AI tool wrappers, base 8, flowchart family)', () => {
  let model: DiagramModel;
  let tools: DiagramTools;

  beforeEach(() => {
    model = {
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    };
    tools = createDiagramTools(
      {
        getModel: () => model,
        setModel: (m) => {
          model = m;
        },
      },
      'flowchart',
    );
  });

  it('addNode adds a node', async () => {
    const result = await tools.addNode.execute!({ shape: 'diamond', label: 'Decision' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true, nodeId: expect.any(String) });
    expect(model.nodes.some((n) => n.label === 'Decision' && n.shape === 'diamond')).toBe(true);
  });

  it('addNode\'s result carries the new node\'s id, so a same-turn addEdge can reference it', async () => {
    // Real bug found via T033 (live-provider validation, not the mock path): a real model creates
    // several nodes then tries to connect them within the same turn, but has no way to learn the
    // opaque generated id addNode assigned — it can only guess (the label text, "node-1", "0", …),
    // and every guess fails. The tool result must surface the id so the model can use it.
    const created = await tools.addNode.execute!({ shape: 'rectangle', label: 'New Shape' }, { toolCallId: 't1', messages: [] });
    expect(created.applied).toBe(true);
    const newNodeId = (created as { nodeId: string }).nodeId;
    expect(model.nodes.some((n) => n.id === newNodeId)).toBe(true);

    const edgeResult = await tools.addEdge.execute!(
      { sourceId: 'a', targetId: newNodeId },
      { toolCallId: 't2', messages: [] },
    );
    expect(edgeResult).toEqual({ applied: true });
    expect(model.edges.some((e) => e.sourceId === 'a' && e.targetId === newNodeId)).toBe(true);
  });

  it('addEdge adds an edge between two existing nodes', async () => {
    model.nodes.push({ id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } });
    const result = await tools.addEdge.execute!({ sourceId: 'a', targetId: 'b' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.edges.some((e) => e.sourceId === 'a' && e.targetId === 'b')).toBe(true);
  });

  it('addEdge reports not-found when a referenced node does not exist', async () => {
    const result = await tools.addEdge.execute!({ sourceId: 'a', targetId: 'does-not-exist' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model.edges).toHaveLength(0);
  });

  it('removeNode removes an existing node', async () => {
    const result = await tools.removeNode.execute!({ nodeId: 'a' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.nodes).toHaveLength(0);
  });

  it('removeNode reports not-found for a nonexistent id without changing the model', async () => {
    const before = model;
    const result = await tools.removeNode.execute!({ nodeId: 'does-not-exist' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });

  it('removeEdge reports not-found for a nonexistent id', async () => {
    const result = await tools.removeEdge.execute!({ edgeId: 'does-not-exist' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });

  it('updateNodeLabel renames an existing node', async () => {
    const result = await tools.updateNodeLabel.execute!({ nodeId: 'a', label: 'Renamed' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.nodes.find((n) => n.id === 'a')!.label).toBe('Renamed');
  });

  it('updateNodeLabel reports not-found for a nonexistent id', async () => {
    const result = await tools.updateNodeLabel.execute!({ nodeId: 'does-not-exist', label: 'X' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });

  it('updateEdgeLabel reports not-found for a nonexistent id', async () => {
    const result = await tools.updateEdgeLabel.execute!({ edgeId: 'does-not-exist', label: 'X' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });

  it('updateNodeStyle sets fillColor/strokeColor on an existing node', async () => {
    const result = await tools.updateNodeStyle.execute!(
      { nodeId: 'a', fillColor: '#1168bd', strokeColor: '#0b4884' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    expect(model.nodes.find((n) => n.id === 'a')!.style).toEqual({ fillColor: '#1168bd', strokeColor: '#0b4884' });
  });

  it('updateNodeStyle reports not-found for a nonexistent id', async () => {
    const result = await tools.updateNodeStyle.execute!(
      { nodeId: 'does-not-exist', fillColor: '#000000' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });

  it('updateEdgeStyle sets strokeColor on an existing edge', async () => {
    model.nodes.push({ id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } });
    model.edges.push({ id: 'e1', sourceId: 'a', targetId: 'b' });
    const result = await tools.updateEdgeStyle.execute!(
      { edgeId: 'e1', strokeColor: '#c0392b' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    expect(model.edges.find((e) => e.id === 'e1')!.style).toEqual({ strokeColor: '#c0392b' });
  });

  it('updateEdgeStyle reports not-found for a nonexistent id', async () => {
    const result = await tools.updateEdgeStyle.execute!(
      { edgeId: 'does-not-exist', strokeColor: '#c0392b' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
  });
});

/**
 * T018 (User Story 2): contract tests for the 8 NEW family-conditional tools T019 will implement.
 * These MUST fail right now — `createDiagramTools` doesn't return any of these tools yet
 * (Constitution IV: the failing test is written before the implementation). Each block below
 * builds its own family-specific model+tools fixture inline, matching the T004 block's own
 * pattern above, rather than reusing the flowchart-only `beforeEach` already in this file.
 */

describe('setNodeRole (c4, sequence)', () => {
  it('c4: sets the role field on an existing node', async () => {
    let model: DiagramModel = {
      diagramTypeId: 'c4',
      nodes: [{ id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'person' }],
      edges: [],
      containers: [],
    };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, 'c4');
    const result = await tools.setNodeRole.execute!({ nodeId: 'a', role: 'system' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.nodes.find((n) => n.id === 'a')!.role).toBe('system');
  });

  it('c4: reports not-found for a nonexistent id without changing the model', async () => {
    let model: DiagramModel = { diagramTypeId: 'c4', nodes: [], edges: [], containers: [] };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, 'c4');
    const before = model;
    const result = await tools.setNodeRole.execute!(
      { nodeId: 'does-not-exist', role: 'system' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });

  it('sequence: sets the role field on an existing node', async () => {
    let model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [{ id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, role: 'participant' }],
      edges: [],
      containers: [],
    };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, 'sequence');
    const result = await tools.setNodeRole.execute!({ nodeId: 'a', role: 'actor' }, { toolCallId: 't1', messages: [] });
    expect(result).toEqual({ applied: true });
    expect(model.nodes.find((n) => n.id === 'a')!.role).toBe('actor');
  });

  it('sequence: reports not-found for a nonexistent id without changing the model', async () => {
    let model: DiagramModel = { diagramTypeId: 'sequence', nodes: [], edges: [], containers: [] };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, 'sequence');
    const before = model;
    const result = await tools.setNodeRole.execute!(
      { nodeId: 'does-not-exist', role: 'actor' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });
});

describe('setEntityAttributes (erd)', () => {
  let model: DiagramModel;
  let tools: DiagramTools;

  beforeEach(() => {
    model = {
      diagramTypeId: 'erd',
      nodes: [
        {
          id: 'a',
          label: 'A',
          shape: 'rectangle',
          position: { x: 0, y: 0 },
          attributes: [{ type: 'string', name: 'oldField', keys: [] }],
        },
      ],
      edges: [],
      containers: [],
    };
    tools = createDiagramTools(
      { getModel: () => model, setModel: (m) => { model = m; } },
      'erd',
    );
  });

  it("replaces the node's attributes array wholesale", async () => {
    const result = await tools.setEntityAttributes.execute!(
      {
        nodeId: 'a',
        attributes: [
          { type: 'int', name: 'id', keys: ['PK'] },
          { type: 'int', name: 'accountId', keys: ['FK'] },
        ],
      },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    const node = model.nodes.find((n) => n.id === 'a')!;
    expect(node.attributes).toEqual([
      { type: 'int', name: 'id', keys: ['PK'] },
      { type: 'int', name: 'accountId', keys: ['FK'] },
    ]);
    expect(node.attributes!.some((attr) => attr.name === 'oldField')).toBe(false);
  });

  it('reports not-found for a nonexistent id without changing the model', async () => {
    const before = model;
    const result = await tools.setEntityAttributes.execute!(
      { nodeId: 'does-not-exist', attributes: [{ type: 'int', name: 'id', keys: ['PK'] }] },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });
});

describe('setClassMembers (uml)', () => {
  let model: DiagramModel;
  let tools: DiagramTools;

  beforeEach(() => {
    model = {
      diagramTypeId: 'uml',
      nodes: [
        {
          id: 'a',
          label: 'A',
          shape: 'rectangle',
          position: { x: 0, y: 0 },
          members: [{ kind: 'attribute', name: 'oldField' }],
        },
      ],
      edges: [],
      containers: [],
    };
    tools = createDiagramTools(
      { getModel: () => model, setModel: (m) => { model = m; } },
      'uml',
    );
  });

  it("replaces the node's members array wholesale", async () => {
    const result = await tools.setClassMembers.execute!(
      {
        nodeId: 'a',
        members: [
          { kind: 'attribute', visibility: '+', name: 'id', type: 'int' },
          { kind: 'method', visibility: '-', name: 'save', params: '', returnType: 'void' },
        ],
      },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    const node = model.nodes.find((n) => n.id === 'a')!;
    expect(node.members).toEqual([
      { kind: 'attribute', visibility: '+', name: 'id', type: 'int' },
      { kind: 'method', visibility: '-', name: 'save', params: '', returnType: 'void' },
    ]);
    expect(node.members!.some((m) => m.name === 'oldField')).toBe(false);
  });

  it('reports not-found for a nonexistent id without changing the model', async () => {
    const before = model;
    const result = await tools.setClassMembers.execute!(
      { nodeId: 'does-not-exist', members: [{ kind: 'attribute', name: 'id' }] },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });
});

describe('setRelationshipKind (uml)', () => {
  let model: DiagramModel;
  let tools: DiagramTools;

  beforeEach(() => {
    model = {
      diagramTypeId: 'uml',
      nodes: [
        { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'a', targetId: 'b', sourceCardinality: '1' }],
      containers: [],
    };
    tools = createDiagramTools(
      { getModel: () => model, setModel: (m) => { model = m; } },
      'uml',
    );
  });

  it('sets umlRelationKind while leaving an already-set sourceCardinality untouched (merge-patch)', async () => {
    const result = await tools.setRelationshipKind.execute!(
      { edgeId: 'e1', umlRelationKind: 'inheritance' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    const edge = model.edges.find((e) => e.id === 'e1')!;
    expect(edge.umlRelationKind).toBe('inheritance');
    expect(edge.sourceCardinality).toBe('1');
  });

  it('reports not-found for a nonexistent id without changing the model', async () => {
    const before = model;
    const result = await tools.setRelationshipKind.execute!(
      { edgeId: 'does-not-exist', umlRelationKind: 'inheritance' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });
});

describe('setConnectorStyle (sequence, flowchart)', () => {
  it('flowchart: merge-patches arrow/lineStyle onto an existing edge', async () => {
    let model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'a', targetId: 'b' }],
      containers: [],
    };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, 'flowchart');
    const result = await tools.setConnectorStyle.execute!(
      { edgeId: 'e1', arrow: 'both', lineStyle: 'dotted' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    const edge = model.edges.find((e) => e.id === 'e1')!;
    expect(edge.arrow).toBe('both');
    expect(edge.lineStyle).toBe('dotted');
  });

  it('flowchart: reports not-found for a nonexistent id without changing the model', async () => {
    let model: DiagramModel = { diagramTypeId: 'flowchart', nodes: [], edges: [], containers: [] };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, 'flowchart');
    const before = model;
    const result = await tools.setConnectorStyle.execute!(
      { edgeId: 'does-not-exist', arrow: 'none' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });

  it('sequence: sets arrow/lineStyle on an existing edge', async () => {
    let model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [
        { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'a', targetId: 'b' }],
      containers: [],
    };
    const tools = createDiagramTools({ getModel: () => model, setModel: (m) => { model = m; } }, 'sequence');
    const result = await tools.setConnectorStyle.execute!(
      { edgeId: 'e1', arrow: 'cross' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    expect(model.edges.find((e) => e.id === 'e1')!.arrow).toBe('cross');
  });
});

describe('groupIntoContainer (architecture, c4, uml, sequence)', () => {
  let model: DiagramModel;
  let tools: DiagramTools;

  beforeEach(() => {
    model = {
      diagramTypeId: 'c4',
      nodes: [
        { id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'b', label: 'B', shape: 'rectangle', position: { x: 200, y: 0 } },
      ],
      edges: [],
      containers: [],
    };
    tools = createDiagramTools(
      { getModel: () => model, setModel: (m) => { model = m; } },
      'c4',
    );
  });

  it('creates exactly one new container and assigns the given nodes to it', async () => {
    const result = await tools.groupIntoContainer.execute!(
      { nodeIds: ['a', 'b'], label: 'Boundary' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result.applied).toBe(true);
    const containerId = (result as { containerId: string }).containerId;
    expect(typeof containerId).toBe('string');
    expect(model.containers).toHaveLength(1);
    expect(model.containers[0].id).toBe(containerId);
    expect(model.nodes.find((n) => n.id === 'a')!.containerId).toBe(containerId);
    expect(model.nodes.find((n) => n.id === 'b')!.containerId).toBe(containerId);
  });

  it('groups only the nodeIds that exist when some are missing', async () => {
    const result = await tools.groupIntoContainer.execute!(
      { nodeIds: ['a', 'does-not-exist'], label: 'Boundary' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result.applied).toBe(true);
    const containerId = (result as { containerId: string }).containerId;
    expect(model.containers).toHaveLength(1);
    expect(model.nodes.find((n) => n.id === 'a')!.containerId).toBe(containerId);
  });

  it('reports not-found and creates no container when none of the given nodeIds exist', async () => {
    const before = model;
    const result = await tools.groupIntoContainer.execute!(
      { nodeIds: ['does-not-exist'], label: 'Boundary' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
    expect(model.containers).toHaveLength(0);
  });
});

describe('activateParticipant / deactivateParticipant (sequence)', () => {
  let model: DiagramModel;
  let tools: DiagramTools;

  beforeEach(() => {
    model = {
      diagramTypeId: 'sequence',
      nodes: [{ id: 'a', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    };
    tools = createDiagramTools(
      { getModel: () => model, setModel: (m) => { model = m; } },
      'sequence',
    );
  });

  it('activateParticipant appends a new activate container', async () => {
    const result = await tools.activateParticipant.execute!(
      { participantId: 'a' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    expect(model.containers).toHaveLength(1);
    expect(model.containers[0]).toMatchObject({ role: 'activate', attachedNodeIds: ['a'] });
  });

  it('activateParticipant reports not-found for a nonexistent participant, without adding a container', async () => {
    const before = model;
    const result = await tools.activateParticipant.execute!(
      { participantId: 'does-not-exist' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });

  it('deactivateParticipant appends a new deactivate container', async () => {
    const result = await tools.deactivateParticipant.execute!(
      { participantId: 'a' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: true });
    expect(model.containers).toHaveLength(1);
    expect(model.containers[0]).toMatchObject({ role: 'deactivate', attachedNodeIds: ['a'] });
  });

  it('deactivateParticipant reports not-found for a nonexistent participant, without adding a container', async () => {
    const before = model;
    const result = await tools.deactivateParticipant.execute!(
      { participantId: 'does-not-exist' },
      { toolCallId: 't1', messages: [] },
    );
    expect(result).toEqual({ applied: false, reason: expect.stringContaining('does-not-exist') });
    expect(model).toBe(before);
  });
});
