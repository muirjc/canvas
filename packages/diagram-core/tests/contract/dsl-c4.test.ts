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
        containers: [
          { id: 'live', label: 'Live', position: { x: 0, y: 0 } },
          { id: 'zone1', label: 'Zone 1', position: { x: 0, y: 0 }, parentContainerId: 'live' },
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
        containers: [{ id: 'b1', label: 'Our System', position: { x: 0, y: 0 } }],
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

    it('Boundary(id, "label", ?"type") -- the generic boundary macro -- parses like System_Boundary', () => {
      const result = parseC4('C4Context\n  Boundary(b3, "Bank Boundary 3", "boundary") {\n    System(a, "A")\n  }\n');
      expect(isParseSuccess(result)).toBe(true);
      if (!isParseSuccess(result)) return;
      expect(result.model.containers).toHaveLength(1);
      expect(result.model.containers[0]).toMatchObject({ id: 'b3', label: 'Bank Boundary 3' });
      expect(result.model.nodes.find((n) => n.id === 'a')?.containerId).toBe('b3');
      // The optional "type" arg is captured-but-discarded, matching this file's own established
      // precedent (Deployment_Node's optional type arg) -- not modeled, not leaked into the label.
      expect(JSON.stringify(result.model)).not.toContain('boundary');
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
  });
});
