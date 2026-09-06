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
      // canvas-7vs.11: role is now what picks the boundary keyword back on serialize -- a
      // container built without one (as this fixture originally was) still round-trips fine, just
      // via the diagramTypeId-driven default; giving it the role a real parse of "System_Boundary"
      // would actually produce is the more realistic fixture and confirms that path too.
      containers: [{ id: 'b1', label: 'Our System', role: 'system-boundary', position: { x: 0, y: 0 } }],
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

  describe('jmuir-dtu.3: expanded element-kind matrix (Db/Queue/_Ext)', () => {
    it('parses SystemQueue to role "system", shape "stadium"', () => {
      const result = parseC4('C4Context\n  SystemQueue(q, "Order Queue")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'q')!;
        expect(node.role).toBe('system');
        expect(node.shape).toBe('stadium');
      }
    });

    it('parses ContainerDb to role "container", shape "cylinder"', () => {
      const result = parseC4('C4Container\n  ContainerDb(db, "Orders DB")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'db')!;
        expect(node.role).toBe('container');
        expect(node.shape).toBe('cylinder');
      }
    });

    it('parses ContainerQueue to role "container", shape "stadium"', () => {
      const result = parseC4('C4Container\n  ContainerQueue(q, "Message Bus")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'q')!;
        expect(node.role).toBe('container');
        expect(node.shape).toBe('stadium');
      }
    });

    it('parses ComponentDb to role "component", shape "cylinder"', () => {
      const result = parseC4('C4Component\n  ComponentDb(db, "Cache")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'db')!;
        expect(node.role).toBe('component');
        expect(node.shape).toBe('cylinder');
      }
    });

    it('parses ComponentQueue to role "component", shape "stadium"', () => {
      const result = parseC4('C4Component\n  ComponentQueue(q, "Event Bus")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'q')!;
        expect(node.role).toBe('component');
        expect(node.shape).toBe('stadium');
      }
    });

    it('parses SystemDb_Ext to the same role/shape as SystemDb (the _Ext simplification)', () => {
      const result = parseC4('C4Context\n  SystemDb_Ext(db, "External DB")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'db')!;
        expect(node.role).toBe('system');
        expect(node.shape).toBe('cylinder');
      }
    });

    it.each([
      ['SystemQueue', 'system', 'stadium'],
      ['ContainerDb', 'container', 'cylinder'],
      ['ContainerQueue', 'container', 'stadium'],
      ['ComponentDb', 'component', 'cylinder'],
      ['ComponentQueue', 'component', 'stadium'],
      ['SystemDb_Ext', 'system', 'cylinder'],
    ] as const)('round-trips %s through serializeC4 -> parseC4', (kind, role, shape) => {
      const model: DiagramModel = {
        diagramTypeId: 'c4-component',
        nodes: [{ id: 'x', label: 'X', shape, role, position: { x: 0, y: 0 } }],
        edges: [],
        containers: [],
      };
      expect(normalize(roundTrip(model))).toEqual(normalize(model));
      // Guard the specific input kind actually parses to the expected role/shape too, not just
      // that the model round-trips whatever canonical kind serializeC4 happens to emit.
      const result = parseC4(`C4Context\n  ${kind}(x, "X")\n`);
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'x')!;
        expect(node.role).toBe(role);
        expect(node.shape).toBe(shape);
      }
    });
  });

  describe('jmuir-dtu.3: Rel variants', () => {
    it('round-trips BiRel with arrow "both"', () => {
      const model: DiagramModel = {
        diagramTypeId: 'c4-context',
        nodes: [
          { id: 'a', label: 'A', shape: 'rectangle', role: 'system', position: { x: 0, y: 0 } },
          { id: 'b', label: 'B', shape: 'rectangle', role: 'system', position: { x: 200, y: 0 } },
        ],
        edges: [{ id: 'e1', sourceId: 'a', targetId: 'b', label: 'Talks to', arrow: 'both' }],
        containers: [],
      };
      const roundTripped = roundTrip(model);
      expect(normalize(roundTripped)).toEqual(normalize(model));
      expect(roundTripped.edges[0].arrow).toBe('both');
    });

    it('Rel_Back(a, b, label) swaps endpoints: sourceId is b, targetId is a', () => {
      const result = parseC4(
        'C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel_Back(a, b, "Responds to")\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.edges).toHaveLength(1);
        const edge = result.model.edges[0];
        expect(edge.sourceId).toBe('b');
        expect(edge.targetId).toBe('a');
        expect(edge.label).toBe('Responds to');
      }
    });

    it.each(['Rel_U', 'Rel_D', 'Rel_L', 'Rel_R', 'Rel_Up', 'Rel_Down', 'Rel_Left', 'Rel_Right'])(
      '%s parses as a plain forward edge (no arrow, endpoints in declared order)',
      (kind) => {
        const result = parseC4(`C4Context\n  System(a, "A")\n  System(b, "B")\n  ${kind}(a, b, "Talks to")\n`);
        expect(isParseSuccess(result)).toBe(true);
        if (isParseSuccess(result)) {
          expect(result.model.edges).toHaveLength(1);
          const edge = result.model.edges[0];
          expect(edge.sourceId).toBe('a');
          expect(edge.targetId).toBe('b');
          expect(edge.arrow).toBeUndefined();
          expect(edge.label).toBe('Talks to');
        }
      },
    );
  });

  describe('jmuir-dtu.3: UpdateElementStyle', () => {
    it('applies $bgColor/$borderColor (named form) to a node declared earlier in the file', () => {
      const result = parseC4(
        'C4Context\n  System(a, "A")\n  UpdateElementStyle(a, $bgColor="#ff0000", $borderColor="#00ff00")\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'a')!;
        expect(node.style?.fillColor).toBe('#ff0000');
        expect(node.style?.strokeColor).toBe('#00ff00');
      }
    });

    it('applies bgColor/borderColor via the positional form', () => {
      const result = parseC4(
        'C4Context\n  System(a, "A")\n  UpdateElementStyle(a, "#ff0000", "#000000", "#00ff00")\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const node = result.model.nodes.find((n) => n.id === 'a')!;
        expect(node.style?.fillColor).toBe('#ff0000');
        expect(node.style?.strokeColor).toBe('#00ff00');
      }
    });

    it('is silently skipped for an unknown element id, rather than failing the parse', () => {
      const result = parseC4(
        'C4Context\n  System(a, "A")\n  UpdateElementStyle(nope, $bgColor="#ff0000")\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.nodes.map((n) => n.id)).toEqual(['a']);
        expect(result.model.nodes[0].style?.fillColor).toBeUndefined();
      }
    });
  });

  describe('jmuir-dtu.3: UpdateRelStyle', () => {
    it('applies $lineColor (named form) to the matching edge\'s strokeColor', () => {
      const result = parseC4(
        'C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "Talks to")\n  UpdateRelStyle(a, b, $lineColor="#123456")\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const edge = result.model.edges.find((e) => e.sourceId === 'a' && e.targetId === 'b')!;
        expect(edge.style?.strokeColor).toBe('#123456');
      }
    });

    it('applies lineColor via the positional form ("textColor", "lineColor", "offsetX", "offsetY")', () => {
      const result = parseC4(
        'C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "Talks to")\n  UpdateRelStyle(a, b, "#ffffff", "#123456", "-10", "10")\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const edge = result.model.edges.find((e) => e.sourceId === 'a' && e.targetId === 'b')!;
        expect(edge.style?.strokeColor).toBe('#123456');
      }
    });

    it('is silently skipped when no edge matches the given source/target pair', () => {
      const result = parseC4(
        'C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "Talks to")\n  UpdateRelStyle(a, c, $lineColor="#123456")\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.edges).toHaveLength(1);
        expect(result.model.edges[0].style?.strokeColor).toBeUndefined();
      }
    });
  });

  it('UpdateLayoutConfig parses without error and produces no observable model change', () => {
    const withoutLayoutConfig = parseC4('C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "Talks to")\n');
    const withLayoutConfig = parseC4(
      'C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "Talks to")\n  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="2")\n',
    );
    expect(isParseSuccess(withoutLayoutConfig)).toBe(true);
    expect(isParseSuccess(withLayoutConfig)).toBe(true);
    if (isParseSuccess(withoutLayoutConfig) && isParseSuccess(withLayoutConfig)) {
      expect(normalize(withLayoutConfig.model)).toEqual(normalize(withoutLayoutConfig.model));
    }
  });

  it('round-trips a full file combining BiRel, Rel_Back, and both styling macros through canvas.edgeStyles', () => {
    const dsl = [
      'C4Context',
      '  System(a, "A")',
      '  System(b, "B")',
      '  System(c, "C")',
      '  BiRel(a, b, "Syncs with")',
      '  Rel_Back(b, c, "Reports to")',
      '  UpdateElementStyle(a, $bgColor="#ff0000")',
      '  UpdateRelStyle(a, b, $lineColor="#00ff00")',
      '',
    ].join('\n');
    const firstParse = parseC4(dsl);
    expect(isParseSuccess(firstParse)).toBe(true);
    if (!isParseSuccess(firstParse)) return;

    // Sanity-check the first parse before round-tripping.
    const biRelEdge = firstParse.model.edges.find((e) => e.sourceId === 'a' && e.targetId === 'b')!;
    expect(biRelEdge.arrow).toBe('both');
    expect(biRelEdge.style?.strokeColor).toBe('#00ff00');
    const relBackEdge = firstParse.model.edges.find((e) => e.sourceId === 'c' && e.targetId === 'b')!;
    expect(relBackEdge).toBeDefined();
    expect(firstParse.model.nodes.find((n) => n.id === 'a')!.style?.fillColor).toBe('#ff0000');

    // Serialize (which must emit canvas.edgeStyles front matter for the styled edge to survive)
    // and re-parse; style and arrow must still be present.
    const serialized = serializeC4(firstParse.model);
    expect(serialized).toContain('edgeStyles:');
    const reparsed = parseC4(serialized);
    expect(isParseSuccess(reparsed)).toBe(true);
    if (!isParseSuccess(reparsed)) return;

    expect(normalize(reparsed.model)).toEqual(normalize(firstParse.model));
    const reBiRelEdge = reparsed.model.edges.find((e) => e.sourceId === 'a' && e.targetId === 'b')!;
    expect(reBiRelEdge.arrow).toBe('both');
    expect(reBiRelEdge.style?.strokeColor).toBe('#00ff00');
    expect(reparsed.model.nodes.find((n) => n.id === 'a')!.style?.fillColor).toBe('#ff0000');
  });

  // jmuir-dtu.3.2 superseded jmuir-dtu.3's original "C4Deployment is out of scope" tests here —
  // C4Deployment/Deployment_Node/Node/Node_L/Node_R are now supported (see the describe block
  // below). RelIndex remains genuinely out of scope, not part of either bead.
  describe('jmuir-dtu.3: still out of scope', () => {
    it('rejects a Node_L call missing its required "{" block opener', () => {
      const result = parseC4('C4Context\n  System(a, "A")\n  System(b, "B")\n  Node_L(a, "Not a boundary")\n');
      expect(isParseSuccess(result)).toBe(false);
    });

    it('rejects RelIndex', () => {
      const result = parseC4('C4Context\n  System(a, "A")\n  System(b, "B")\n  RelIndex(0, a, b, "Rel")\n');
      expect(isParseSuccess(result)).toBe(false);
    });
  });

  describe('jmuir-dtu.3.2: C4Deployment', () => {
    it('parses a C4Deployment header to diagramTypeId "c4-deployment"', () => {
      const result = parseC4('C4Deployment\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.diagramTypeId).toBe('c4-deployment');
      }
    });

    it('Deployment_Node(id, "Label") (no type arg) creates a container with the right id/label', () => {
      const result = parseC4('C4Deployment\n  Deployment_Node(live, "Live") {\n  }\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.containers).toHaveLength(1);
        const container = result.model.containers[0];
        expect(container.id).toBe('live');
        expect(container.label).toBe('Live');
      }
    });

    it('Deployment_Node(id, "Label", "Type") (with optional type arg) parses; the type is not retained anywhere and does not leak into the label', () => {
      const result = parseC4('C4Deployment\n  Deployment_Node(live, "Live", "Azure") {\n  }\n');
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.containers).toHaveLength(1);
        const container = result.model.containers[0];
        expect(container.label).toBe('Live');
        expect(JSON.stringify(result.model)).not.toContain('Azure');
      }
    });

    it('nested Deployment_Node blocks (2+ levels) produce the correct parentContainerId chain', () => {
      const result = parseC4(
        [
          'C4Deployment',
          '  Deployment_Node(live, "Live") {',
          '    Deployment_Node(zone1, "Zone 1") {',
          '      Deployment_Node(server1, "Server 1") {',
          '      }',
          '    }',
          '  }',
          '',
        ].join('\n'),
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        const byId = new Map(result.model.containers.map((c) => [c.id, c]));
        expect(byId.get('live')?.parentContainerId).toBeUndefined();
        expect(byId.get('zone1')?.parentContainerId).toBe('live');
        expect(byId.get('server1')?.parentContainerId).toBe('zone1');
      }
    });

    it('regular C4 elements nested inside a Deployment_Node get the correct containerId', () => {
      const result = parseC4(
        [
          'C4Deployment',
          '  Deployment_Node(live, "Live") {',
          '    Container(web, "Web Server")',
          '    Component(app, "App Component")',
          '  }',
          '',
        ].join('\n'),
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.nodes.find((n) => n.id === 'web')?.containerId).toBe('live');
        expect(result.model.nodes.find((n) => n.id === 'app')?.containerId).toBe('live');
      }
    });

    it.each(['Deployment_Node', 'Node', 'Node_L', 'Node_R'] as const)(
      '%s works identically to Deployment_Node: parses to a container of the same shape',
      (kind) => {
        const result = parseC4(`C4Deployment\n  ${kind}(live, "Live") {\n  }\n`);
        expect(isParseSuccess(result)).toBe(true);
        if (isParseSuccess(result)) {
          expect(result.model.containers).toHaveLength(1);
          const container = result.model.containers[0];
          expect(container.id).toBe('live');
          expect(container.label).toBe('Live');
          expect(container.parentContainerId).toBeUndefined();
        }
      },
    );

    it('a Rel between two elements nested in different Deployment_Nodes resolves sourceId/targetId regardless of nesting', () => {
      const result = parseC4(
        [
          'C4Deployment',
          '  Deployment_Node(zoneA, "Zone A") {',
          '    Container(web, "Web Server")',
          '  }',
          '  Deployment_Node(zoneB, "Zone B") {',
          '    ContainerDb(db, "Database")',
          '  }',
          '  Rel(web, db, "Reads/Writes")',
          '',
        ].join('\n'),
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.edges).toHaveLength(1);
        const edge = result.model.edges[0];
        expect(edge.sourceId).toBe('web');
        expect(edge.targetId).toBe('db');
      }
    });

    it('round-trips a full C4Deployment diagram (nesting + elements + a Rel): serialized output uses Deployment_Node(, never System_Boundary(', () => {
      const model: DiagramModel = {
        diagramTypeId: 'c4-deployment',
        nodes: [
          { id: 'web', label: 'Web Server', shape: 'rounded-rectangle', role: 'container', position: { x: 0, y: 0 }, containerId: 'zone1' },
          { id: 'db', label: 'Database', shape: 'cylinder', role: 'container', position: { x: 200, y: 0 }, containerId: 'live' },
        ],
        edges: [{ id: 'e1', sourceId: 'web', targetId: 'db', label: 'Reads/Writes' }],
        // canvas-7vs.11: role now round-trips too (see the sibling fixture fix a few tests up) --
        // these containers get it here so the round-trip below is a true fixed point; the
        // diagramTypeId-driven default fallback (still exercised by this test's own serialize
        // assertions) is what a role-LESS container would fall back to instead.
        containers: [
          { id: 'live', label: 'Live', role: 'deployment-node', position: { x: 0, y: 0 } },
          { id: 'zone1', label: 'Zone 1', role: 'deployment-node', position: { x: 0, y: 0 }, parentContainerId: 'live' },
        ],
      };
      const serialized = serializeC4(model);
      expect(serialized).toContain('Deployment_Node(');
      expect(serialized).not.toContain('System_Boundary(');
      expect(normalize(roundTrip(model))).toEqual(normalize(model));
    });

    it('regression guard: a System_Boundary/Container_Boundary diagram (non-c4-deployment diagramTypeId) is unchanged — still round-trips as System_Boundary(, never Deployment_Node(', () => {
      const model: DiagramModel = {
        diagramTypeId: 'c4-container',
        nodes: [
          { id: 'web', label: 'Web App', shape: 'rounded-rectangle', role: 'container', position: { x: 0, y: 0 }, containerId: 'b1' },
          { id: 'db', label: 'Database', shape: 'cylinder', role: 'system', position: { x: 200, y: 0 } },
        ],
        edges: [{ id: 'e1', sourceId: 'web', targetId: 'db', label: 'Reads/Writes' }],
        containers: [{ id: 'b1', label: 'Our System', role: 'system-boundary', position: { x: 0, y: 0 } }],
      };
      const serialized = serializeC4(model);
      expect(serialized).toContain('System_Boundary(');
      expect(serialized).not.toContain('Deployment_Node(');
      expect(normalize(roundTrip(model))).toEqual(normalize(model));
    });

    it('regression guard: Deployment_Node used inside a C4Context diagram parses successfully (deliberate leniency, same precedent as System_Boundary)', () => {
      const result = parseC4(
        [
          'C4Context',
          '  Deployment_Node(live, "Live") {',
          '    System(a, "A")',
          '  }',
          '',
        ].join('\n'),
      );
      expect(isParseSuccess(result)).toBe(true);
      if (isParseSuccess(result)) {
        expect(result.model.diagramTypeId).toBe('c4-context');
        expect(result.model.containers).toHaveLength(1);
        expect(result.model.containers[0].id).toBe('live');
        expect(result.model.nodes.find((n) => n.id === 'a')?.containerId).toBe('live');
      }
    });
  });

  describe('canvas-7vs.11: which boundary keyword was used is now captured, not discarded', () => {
    // The boundary keyword itself used to be discarded entirely -- every one of these five
    // collapsed into the exact same untyped DiagramContainer (role left undefined), confirmed
    // live against a real bank-boundary example that mixes several of them in one diagram.
    const CASES: Array<{ keyword: string; role: string }> = [
      { keyword: 'Boundary', role: 'boundary' },
      { keyword: 'System_Boundary', role: 'system-boundary' },
      { keyword: 'Container_Boundary', role: 'container-boundary' },
      { keyword: 'Enterprise_Boundary', role: 'enterprise-boundary' },
      { keyword: 'Deployment_Node', role: 'deployment-node' },
    ];

    it.each(CASES)('$keyword gets its own distinct role ($role), and round-trips back to the identical keyword', ({ keyword, role }) => {
      const result = parseC4(`C4Context\n  ${keyword}(b1, "A Boundary") {\n    System(a, "A")\n  }\n`);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const container = result.model.containers.find((c) => c.id === 'b1')!;
      expect(container.role).toBe(role);

      const reexported = serializeC4(result.model);
      // Exactly the one matching keyword, never a DIFFERENT one of the five (the exact bug this
      // closes) -- extracts the actual emitted keyword token rather than a plain `.toContain`
      // check, since e.g. "System_Boundary(b1," itself contains the substring "Boundary(b1,",
      // which would give a false pass for the wrong keyword.
      const actualKeyword = reexported.match(/(\w+)\(b1, "A Boundary"\)/)?.[1];
      expect(actualKeyword).toBe(keyword);

      const reparsed = parseC4(reexported);
      expect(isParseSuccess(reparsed)).toBe(true);
      if (!isParseSuccess(reparsed)) return;
      expect(reparsed.model.containers.find((c) => c.id === 'b1')?.role).toBe(role);
    });

    it('the Node/Node_L/Node_R Deployment_Node shortcuts all collapse to the same deployment-node role (matching ELEMENT_TO_ROLE\'s own precedent for element-kind variants)', () => {
      for (const keyword of ['Node', 'Node_L', 'Node_R']) {
        const result = parseC4(`C4Deployment\n  ${keyword}(live, "Live") {\n    System(a, "A")\n  }\n`);
        expect(isParseSuccess(result)).toBe(true);
        if (!isParseSuccess(result)) return;
        expect(result.model.containers.find((c) => c.id === 'live')?.role).toBe('deployment-node');
      }
    });

    it('the real reported bank-boundary example mixes Enterprise_Boundary/System_Boundary/Boundary in one diagram, and each keeps its own distinct role', () => {
      const dsl = [
        'C4Context',
        'Enterprise_Boundary(b0, "BankBoundary0") {',
        '  System_Boundary(b1, "BankBoundary") {',
        '    System_Boundary(b2, "BankBoundary2") {',
        '      System(sysA, "System A")',
        '    }',
        '    Boundary(b3, "BankBoundary3") {',
        '      System(sysB, "System B")',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n');
      const result = parseC4(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      const roleOf = (id: string) => result.model.containers.find((c) => c.id === id)?.role;
      expect(roleOf('b0')).toBe('enterprise-boundary');
      expect(roleOf('b1')).toBe('system-boundary');
      expect(roleOf('b2')).toBe('system-boundary');
      expect(roleOf('b3')).toBe('boundary');

      // Stable through a full round-trip, each keyword distinct from the other two.
      const reexported = serializeC4(result.model);
      expect(reexported).toContain('Enterprise_Boundary(b0,');
      expect(reexported).toContain('System_Boundary(b1,');
      expect(reexported).toContain('System_Boundary(b2,');
      expect(reexported).toContain('Boundary(b3,');
    });
  });

  describe('canvas-79b: title, generic Boundary macro, Rel technology arg', () => {
    it('parses a top-level "title" line and round-trips it through serialize -> reparse', () => {
      const result = parseC4('C4Context\n  title System Context diagram for Internet Banking System\n  System(a, "A")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.title).toBe('System Context diagram for Internet Banking System');

      const reparsed = roundTrip(result.model);
      expect(reparsed.title).toBe('System Context diagram for Internet Banking System');
    });

    it('a model with no title omits the "title" line entirely on serialize', () => {
      const result = parseC4('C4Context\n  System(a, "A")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.title).toBeUndefined();
      expect(serializeC4(result.model)).not.toContain('title');
    });

    it('Boundary(id, "label", ?"type") -- the generic boundary macro -- parses with its own distinct role, not System_Boundary\'s', () => {
      // canvas-7vs.11: "perimeter", not "boundary", as the throwaway 3rd-arg value -- the word
      // "boundary" is now a real, meaningful substring of this container's own role
      // ("role":"boundary"), so asserting the whole model never contains it (below) would
      // otherwise collide with correct new behavior rather than catching an actual leak.
      const result = parseC4('C4Context\n  Boundary(b3, "Bank Boundary 3", "perimeter") {\n    System(a, "A")\n  }\n');
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.containers).toHaveLength(1);
      expect(result.model.containers[0]).toMatchObject({ id: 'b3', label: 'Bank Boundary 3', role: 'boundary' });
      expect(result.model.nodes.find((n) => n.id === 'a')?.containerId).toBe('b3');
      // The optional "type" arg is captured-but-discarded, matching this file's own established
      // precedent (Deployment_Node's optional type arg) -- not modeled, not leaked into the label.
      expect(JSON.stringify(result.model)).not.toContain('perimeter');
    });

    it('Rel(from, to, "label", "technology") -- the optional 4th arg -- parses without error', () => {
      const result = parseC4('C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "Sends e-mails", "SMTP")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.edges).toHaveLength(1);
      expect(result.model.edges[0].label).toBe('Sends e-mails');
      // Captured-but-discarded, matching ELEMENT_PATTERN's own established treatment of the
      // optional description arg -- not modeled, not leaked into the label.
      expect(JSON.stringify(result.model)).not.toContain('SMTP');
    });

    it('a 3-arg Rel (no technology) still parses exactly as before -- no regression', () => {
      const result = parseC4('C4Context\n  System(a, "A")\n  System(b, "B")\n  Rel(a, b, "Sends e-mails")\n');
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.edges[0].label).toBe('Sends e-mails');
    });

    it('the real reported bank-boundary example (title + nested Enterprise_Boundary/System_Boundary/Boundary + BiRel + 4-arg Rel) parses end-to-end with zero errors', () => {
      const dsl = [
        'C4Context',
        '    title System Context diagram for Internet Banking System',
        '    Enterprise_Boundary(b0, "BankBoundary0") {',
        '        Person(customerA, "Banking Customer A", "A customer of the bank, with personal bank accounts.")',
        '        System(SystemAA, "Internet Banking System", "Allows customers to view information about their bank accounts, and make payments.")',
        '        Enterprise_Boundary(b1, "BankBoundary") {',
        '            SystemDb_Ext(SystemE, "Mainframe Banking System", "Stores all of the core banking information.")',
        '            System_Boundary(b2, "BankBoundary2") {',
        '                System(SystemA, "Banking System A")',
        '            }',
        '            System_Ext(SystemC, "E-mail system", "The internal Microsoft Exchange e-mail system.")',
        '            Boundary(b3, "BankBoundary3", "boundary") {',
        '                SystemQueue(SystemF, "Banking System F Queue", "A system of the bank.")',
        '            }',
        '        }',
        '    }',
        '    BiRel(customerA, SystemAA, "Uses")',
        '    Rel(SystemAA, SystemC, "Sends e-mails", "SMTP")',
        '',
      ].join('\n');
      const result = parseC4(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      // customerA, SystemAA, SystemE, SystemA, SystemC, SystemF
      expect(result.model.nodes).toHaveLength(6);
      expect(result.model.containers).toHaveLength(4);
      expect(result.model.edges).toHaveLength(2);

      // Full round-trip, not just a one-way parse.
      const reparsed = roundTrip(result.model);
      expect(reparsed.title).toBe(result.model.title);
      expect(reparsed.nodes).toHaveLength(6);
      expect(reparsed.containers).toHaveLength(4);
      expect(reparsed.edges).toHaveLength(2);
    });

    // Reported live: every Container(...)/ContainerDb(...) line in a real C4Container bank
    // example hard-errored ("Could not interpret line as a C4 element, relationship, or
    // boundary") because ELEMENT_PATTERN only ever allowed ONE optional trailing quoted arg
    // (Person/System's own "?description"), but Container/Component's real Mermaid grammar takes
    // TWO -- "technology" then "description" -- e.g. Container(api, "API Application", "Java,
    // Docker", "Provides banking functionality..."). Fixed by accepting any number of trailing
    // quoted args generically, matching this file's own pre-existing "capture optionally, don't
    // model" precedent.
    it('Container(id, "label", "technology", "description") -- the real 4-arg form -- parses without error', () => {
      const result = parseC4(
        'C4Container\n  Container_Boundary(c1, "Internet Banking") {\n' +
          '    Container(web_app, "Web Application", "JavaScript, React", "Delivers the static content and the SPA")\n' +
          '    ContainerDb(database, "Database", "SQL Database", "Stores user registration, hashed auth credentials, access logs")\n' +
          '  }\n',
      );
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.nodes).toHaveLength(2);
      const webApp = result.model.nodes.find((n) => n.id === 'web_app');
      expect(webApp).toMatchObject({ label: 'Web Application', role: 'container', containerId: 'c1' });
      const database = result.model.nodes.find((n) => n.id === 'database');
      expect(database).toMatchObject({ label: 'Database', role: 'container', shape: 'cylinder' });
      // Technology and description are captured-but-discarded, same as Person's own optional
      // description arg -- not modeled, not leaked into the label.
      expect(JSON.stringify(result.model)).not.toContain('JavaScript, React');
      expect(JSON.stringify(result.model)).not.toContain('Stores user registration');
    });

    it('the real reported bank-boundary C4Container example (5 Container/ContainerDb macros, each with technology + description) parses end-to-end with zero errors', () => {
      const dsl = [
        'C4Container',
        '    title Container diagram for Internet Banking System',
        '',
        '    Person(customer, "Banking Customer", "A customer of the bank, with personal bank accounts")',
        '    System_Ext(email_system, "E-Mail System", "The internal Microsoft Exchange system")',
        '',
        '    Container_Boundary(c1, "Internet Banking") {',
        '        Container(web_app, "Web Application", "JavaScript, React", "Delivers the static content and the SPA")',
        '        Container(spa, "Single-Page App", "JavaScript, React", "Provides all banking functionality via the browser")',
        '        Container(mobile_app, "Mobile App", "C#, Xamarin", "Provides a subset of banking functionality")',
        '        ContainerDb(database, "Database", "SQL Database", "Stores user registration, hashed auth credentials, access logs")',
        '        Container(backend_api, "API Application", "Java, Docker", "Provides banking functionality via JSON/HTTPS API")',
        '    }',
        '',
        '    Rel(customer, web_app, "Uses", "HTTPS")',
        '    Rel(customer, spa, "Uses", "HTTPS")',
        '    Rel(customer, mobile_app, "Uses")',
        '    Rel(web_app, spa, "Delivers")',
        '    Rel(spa, backend_api, "Makes API calls to", "JSON/HTTPS")',
        '    Rel(mobile_app, backend_api, "Makes API calls to", "JSON/HTTPS")',
        '    Rel(backend_api, database, "Reads from and writes to", "JDBC")',
        '    Rel(email_system, customer, "Sends e-mails to")',
        '    Rel(backend_api, email_system, "Sends e-mails using", "SMTP")',
        '',
      ].join('\n');
      const result = parseC4(dsl);
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      // customer, email_system, web_app, spa, mobile_app, database, backend_api
      expect(result.model.nodes).toHaveLength(7);
      expect(result.model.containers).toHaveLength(1);
      expect(result.model.edges).toHaveLength(9);

      const reparsed = roundTrip(result.model);
      expect(reparsed.nodes).toHaveLength(7);
      expect(reparsed.containers).toHaveLength(1);
      expect(reparsed.edges).toHaveLength(9);
    });
  });
});
