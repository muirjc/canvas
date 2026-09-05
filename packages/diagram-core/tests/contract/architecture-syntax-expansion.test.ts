import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '../../src/dsl/architecture.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

/**
 * jmuir-dtu.5: architecture-beta grammar expansion — junction nodes, the `{group}` edge
 * modifier, `align row`/`align column` declarations, and iconify.design custom icon packs.
 * Matches this DSL family's existing `architecture-arrowhead-edges.test.ts` style (direct
 * DSL-string parsing) plus `dsl-architecture.test.ts`'s normalize()/roundTrip() model-first
 * style for the combined round-trip case.
 */

function normalize(model: DiagramModel) {
  return {
    diagramTypeId: model.diagramTypeId,
    nodes: [...model.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...model.edges].sort((a, b) => a.id.localeCompare(b.id)),
    containers: [...model.containers].sort((a, b) => a.id.localeCompare(b.id)),
    architectureAlignments: model.architectureAlignments,
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

describe('architecture parser: junction nodes', () => {
  const base = 'architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n';

  it('parses a bare junction line to a routing-point node', () => {
    const result = parseArchitecture(`${base}  junction j1\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'j1');
      expect(node).toBeDefined();
      expect(node?.label).toBe('');
      expect(node?.shape).toBe('circle');
      expect(node?.role).toBe('junction');
      expect(node?.containerId).toBeUndefined();
    }
  });

  it('parses a junction with an "in <groupId>" clause', () => {
    const dsl = `architecture-beta\n  group g1(cloud)[Group]\n  junction j1 in g1\n`;
    const result = parseArchitecture(dsl);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 'j1');
      expect(node?.containerId).toBe('g1');
      expect(node?.role).toBe('junction');
    }
  });

  it('round-trips a junction (bare and in a group) through export and re-import', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        { id: 'j1', label: '', shape: 'circle', role: 'junction', position: { x: 0, y: 0 } },
        {
          id: 'j2',
          label: '',
          shape: 'circle',
          role: 'junction',
          position: { x: 100, y: 0 },
          containerId: 'g1',
        },
      ],
      edges: [],
      containers: [
        { id: 'g1', label: 'Group', position: { x: -20, y: -20 }, size: { width: 300, height: 200 } },
      ],
    };
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('allows an edge to reference a junction id as source or target, same as a service', () => {
    const result = parseArchitecture(`${base}  junction j1\n  a --> j1\n  j1 --> b\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.edges).toHaveLength(2);
      expect(result.model.edges[0]).toMatchObject({ sourceId: 'a', targetId: 'j1', arrow: 'target' });
      expect(result.model.edges[1]).toMatchObject({ sourceId: 'j1', targetId: 'b', arrow: 'target' });
    }
  });
});

describe('architecture parser: {group} edge modifier', () => {
  const base = 'architecture-beta\n  group g1(cloud)[G1]\n  group g2(cloud)[G2]\n' +
    '  service server(server)[Server] in g1\n  service subnet(server)[Subnet] in g2\n';

  it('sets sourceIsGroup on a source-endpoint {group} modifier, sourceId still the service id', () => {
    const result = parseArchitecture(`${base}  server{group} --> subnet\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.sourceId).toBe('server');
      expect(edge.targetId).toBe('subnet');
      expect(edge.sourceIsGroup).toBe(true);
      expect(edge.targetIsGroup).toBeUndefined();
    }
  });

  it('sets targetIsGroup on a target-endpoint {group} modifier, targetId still the service id', () => {
    const result = parseArchitecture(`${base}  server --> subnet{group}\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.sourceId).toBe('server');
      expect(edge.targetId).toBe('subnet');
      expect(edge.sourceIsGroup).toBeUndefined();
      expect(edge.targetIsGroup).toBe(true);
    }
  });

  it('sets both sourceIsGroup and targetIsGroup when {group} appears on both endpoints', () => {
    const result = parseArchitecture(`${base}  server{group} --> subnet{group}\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.sourceId).toBe('server');
      expect(edge.targetId).toBe('subnet');
      expect(edge.sourceIsGroup).toBe(true);
      expect(edge.targetIsGroup).toBe(true);
    }
  });

  it('parses {group} combined with an anchor on the same endpoint (Mermaid\'s own documented example)', () => {
    const result = parseArchitecture(`${base}  server{group}:B --> T:subnet{group}\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.sourceId).toBe('server');
      expect(edge.targetId).toBe('subnet');
      expect(edge.sourceAnchor).toBe('B');
      expect(edge.targetAnchor).toBe('T');
      expect(edge.sourceIsGroup).toBe(true);
      expect(edge.targetIsGroup).toBe(true);
    }
  });

  it('parses {group} WITHOUT an anchor on an endpoint (the two are independent)', () => {
    const result = parseArchitecture(`${base}  server{group} --> T:subnet\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const edge = result.model.edges[0];
      expect(edge.sourceAnchor).toBeUndefined();
      expect(edge.sourceIsGroup).toBe(true);
      expect(edge.targetAnchor).toBe('T');
      expect(edge.targetIsGroup).toBeUndefined();
    }
  });

  it('round-trips a {group}-modified edge (both endpoints, with anchors) through export and re-import', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        {
          id: 'server',
          label: 'Server',
          shape: 'icon',
          position: { x: 0, y: 0 },
          containerId: 'g1',
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'ec2' },
        },
        {
          id: 'subnet',
          label: 'Subnet',
          shape: 'icon',
          position: { x: 200, y: 0 },
          containerId: 'g2',
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'vpc' },
        },
      ],
      edges: [
        {
          id: 'e1',
          sourceId: 'server',
          targetId: 'subnet',
          arrow: 'target',
          sourceAnchor: 'B',
          targetAnchor: 'T',
          sourceIsGroup: true,
          targetIsGroup: true,
        },
      ],
      containers: [
        { id: 'g1', label: 'G1', position: { x: -20, y: -20 }, size: { width: 100, height: 100 } },
        { id: 'g2', label: 'G2', position: { x: 180, y: -20 }, size: { width: 100, height: 100 } },
      ],
    };
    const dsl = serializeArchitecture(model);
    expect(dsl).toMatch(/server\{group\}:B\s*-->\s*T:subnet\{group\}/);
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });
});

describe('architecture parser: align row/column', () => {
  const base = 'architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  service c(server)[C]\n';

  it('parses "align row" into architectureAlignments with axis "row"', () => {
    const result = parseArchitecture(`${base}  align row a b c\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.architectureAlignments).toEqual([{ axis: 'row', ids: ['a', 'b', 'c'] }]);
    }
  });

  it('parses "align column" into architectureAlignments with axis "column"', () => {
    const result = parseArchitecture(`${base}  align column a b\n`);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.architectureAlignments).toEqual([{ axis: 'column', ids: ['a', 'b'] }]);
    }
  });

  it('a diagram with no align line leaves architectureAlignments undefined, not an empty array', () => {
    const result = parseArchitecture(base);
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      expect(result.model.architectureAlignments).toBeUndefined();
    }
  });

  it('round-trips align row as a literal "align row ..." body line', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        {
          id: 'a',
          label: 'A',
          shape: 'icon',
          position: { x: 0, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'ec2' },
        },
        {
          id: 'b',
          label: 'B',
          shape: 'icon',
          position: { x: 200, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 's3' },
        },
      ],
      edges: [],
      containers: [],
      architectureAlignments: [{ axis: 'row', ids: ['a', 'b'] }],
    };
    const dsl = serializeArchitecture(model);
    expect(dsl).toContain('align row a b');
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });

  it('round-trips align column as a literal "align column ..." body line', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        {
          id: 'a',
          label: 'A',
          shape: 'icon',
          position: { x: 0, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'ec2' },
        },
        {
          id: 'b',
          label: 'B',
          shape: 'icon',
          position: { x: 200, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 's3' },
        },
      ],
      edges: [],
      containers: [],
      architectureAlignments: [{ axis: 'column', ids: ['a', 'b'] }],
    };
    const dsl = serializeArchitecture(model);
    expect(dsl).toContain('align column a b');
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });
});

describe('architecture parser: iconify.design custom icon packs', () => {
  it('parses an iconify-style "prefix:icon-name" icon reference distinctly from a bare icon id', () => {
    const result = parseArchitecture('architecture-beta\n  service s(logos:aws-lambda)[Lambda]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 's');
      expect(node?.icon).toEqual({ libraryId: 'logos', libraryVersion: 'iconify', iconId: 'aws-lambda' });
    }
  });

  it('leaves a regular bare icon name (no colon) resolving to the generic library, unaffected', () => {
    const result = parseArchitecture('architecture-beta\n  service s(ec2)[EC2]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (isParseSuccess(result)) {
      const node = result.model.nodes.find((n) => n.id === 's');
      expect(node?.icon).toEqual({ libraryId: 'generic', libraryVersion: '1.0.0', iconId: 'ec2' });
    }
  });

  it('round-trips an iconify icon, re-serializing the DSL body itself as "prefix:icon-name" in the parens', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        {
          id: 's',
          label: 'Lambda',
          shape: 'icon',
          position: { x: 0, y: 0 },
          icon: { libraryId: 'logos', libraryVersion: 'iconify', iconId: 'aws-lambda' },
        },
      ],
      edges: [],
      containers: [],
    };
    const dsl = serializeArchitecture(model);
    expect(dsl).toContain('service s(logos:aws-lambda)[Lambda]');
    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });
});

describe('architecture parser: combined syntax expansion round-trip', () => {
  it('round-trips a junction, a {group} edge, an align line, an iconify icon, and a plain group/service/edge together', () => {
    const model: DiagramModel = {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        {
          id: 'lambda1',
          label: 'Lambda',
          shape: 'icon',
          position: { x: 0, y: 0 },
          containerId: 'vpc1',
          icon: { libraryId: 'logos', libraryVersion: 'iconify', iconId: 'aws-lambda' },
        },
        {
          id: 'db1',
          label: 'DB',
          shape: 'icon',
          position: { x: 200, y: 0 },
          icon: { libraryId: 'aws-icons', libraryVersion: '2024.1', iconId: 'dynamodb' },
        },
        {
          id: 'j1',
          label: '',
          shape: 'circle',
          role: 'junction',
          position: { x: 400, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', sourceId: 'lambda1', targetId: 'j1', arrow: 'target', sourceIsGroup: true },
        { id: 'e2', sourceId: 'j1', targetId: 'db1', arrow: 'target' },
      ],
      containers: [{ id: 'vpc1', label: 'VPC', position: { x: -20, y: -20 }, size: { width: 300, height: 200 } }],
      architectureAlignments: [{ axis: 'row', ids: ['lambda1', 'db1'] }],
    };

    const dsl = serializeArchitecture(model);
    expect(dsl).toContain('junction j1');
    expect(dsl).toContain('lambda1{group}');
    expect(dsl).toContain('align row lambda1 db1');
    expect(dsl).toContain('service lambda1(logos:aws-lambda)[Lambda]');

    expect(normalize(roundTrip(model))).toEqual(normalize(model));
  });
});

// canvas-vtg: 'title <text>' now recognized outside C4 too (canvas-79b introduced it there
// first) -- previously hard-errored the whole parse for every one of the other 5 families.
describe('architecture parser: "title" directive (canvas-vtg)', () => {
  it('parses a top-level "title" line and round-trips it through serialize -> reparse', () => {
    const result = parseArchitecture('architecture-beta\ntitle My Diagram\nservice a(cloud)[A]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBe('My Diagram');

    const reparsed = parseArchitecture(serializeArchitecture(result.model));
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;
    expect(reparsed.model.title).toBe('My Diagram');
  });

  it('a model with no title omits the "title" line entirely on serialize (no regression)', () => {
    const result = parseArchitecture('architecture-beta\nservice a(cloud)[A]\n');
    expect(isParseSuccess(result)).toBe(true);
    if (!isParseSuccess(result)) return;
    expect(result.model.title).toBeUndefined();
    expect(serializeArchitecture(result.model)).not.toContain('title');
  });
});
