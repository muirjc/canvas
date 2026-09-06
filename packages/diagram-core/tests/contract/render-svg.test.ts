import { describe, expect, it } from 'vitest';
import {
  renderToSvg,
  splitLabelLines,
  iconNodeSize,
  nodeSize,
  tableNodeLayout,
  cardinalityGlyphs,
  umlEndpointGlyph,
  type CardinalityGlyph,
} from '../../src/render/svg-renderer.js';
import type { DiagramModel, DiagramNode } from '../../src/model/diagram-model.js';

/**
 * Constitution's export constraint: exported SVG/PNG MUST NOT embed tracking pixels, telemetry,
 * or external network calls. renderToSvg output is the direct input to both SVG export and
 * server-side PNG rasterization (research.md §4), so this must hold for the SVG itself.
 */
describe('renderToSvg output', () => {
  const model: DiagramModel = {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'A', label: 'Node A', shape: 'rectangle', position: { x: 0, y: 0 } },
      { id: 'B', label: 'Node B', shape: 'circle', position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', label: 'flows to' }],
    containers: [
      { id: 'c1', label: 'Container', position: { x: -20, y: -20 }, size: { width: 400, height: 200 } },
    ],
  };

  it('produces well-formed, self-contained SVG', () => {
    const svg = renderToSvg(model);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('</svg>');
  });

  it('contains no external network or font references', () => {
    // The SVG/XML namespace declarations (xmlns="http://www.w3.org/2000/svg") are standard,
    // required, and resolve nothing over the network — they're not an "external reference" in
    // the sense the constitution's export constraint cares about. What must never appear is an
    // actual fetch: a linked image, an @import, or an href/src pointing at a remote URL.
    const svg = renderToSvg(model);
    expect(svg).not.toMatch(/@import/);
    expect(svg).not.toMatch(/<image\b/);
    expect(svg).not.toMatch(/(?:xlink:href|href|src)\s*=\s*["']https?:/);
  });

  it('renders every node, edge, and container as an identifiable element', () => {
    const svg = renderToSvg(model);
    expect(svg).toContain('data-node-id="A"');
    expect(svg).toContain('data-node-id="B"');
    expect(svg).toContain('data-edge-id="e1"');
    expect(svg).toContain('data-container-id="c1"');
    expect(svg).toContain('Node A');
    expect(svg).toContain('flows to');
  });

  it('escapes XML-sensitive characters in labels', () => {
    const withSpecialChars: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: 'A & B <C>', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    };
    const svg = renderToSvg(withSpecialChars);
    expect(svg).toContain('A &amp; B &lt;C&gt;');
    expect(svg).not.toContain('A & B <C>');
  });

  // jmuir-t2p: hardening, not a live defect at the time this was written -- every escaped value
  // lands in a double-quoted attribute or text content today, where a raw apostrophe can't break
  // out of anything. Escaping it anyway makes escapeXml correct in every XML context rather than
  // relying on every future call site staying double-quoted/text-only.
  it("escapes apostrophes in labels", () => {
    const withApostrophe: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: "A's B", shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    };
    const svg = renderToSvg(withApostrophe);
    expect(svg).toContain('A&apos;s B');
    expect(svg).not.toContain("A's B");
  });
});

/**
 * Feature 006 (FR-015 / SC-009): containers must appear in exports with their names and
 * membership, so an exported diagram matches the canvas.
 *
 * Note what this does NOT do: it adds no rendering code. Containers are already serialized as
 * `subgraph` and already drawn by renderToSvg — this feature adds interaction, not appearance,
 * so svg-renderer.ts is deliberately untouched (research §7).
 */
describe('renderToSvg container fidelity', () => {
  const withContainers: DiagramModel = {
    diagramTypeId: 'flowchart',
    nodes: [
      { id: 'a', label: 'Validate', shape: 'rectangle', position: { x: 60, y: 60 }, containerId: 'dom' },
      { id: 'b', label: 'Approve', shape: 'rectangle', position: { x: 240, y: 60 }, containerId: 'dom' },
      { id: 'c', label: 'Outside', shape: 'rectangle', position: { x: 600, y: 400 } },
    ],
    edges: [{ id: 'e1', sourceId: 'a', targetId: 'b' }],
    containers: [
      { id: 'dom', label: 'Payments Domain', position: { x: 20, y: 20 }, size: { width: 400, height: 200 } },
    ],
  };

  it('renders each container as an identifiable element carrying its name', () => {
    const svg = renderToSvg(withContainers);
    expect(svg).toContain('data-container-id="dom"');
    expect(svg).toContain('Payments Domain');
  });

  it('renders an empty container just as it renders a populated one', () => {
    const svg = renderToSvg({
      ...withContainers,
      nodes: [],
      edges: [],
      containers: [
        { id: 'empty', label: 'Empty Region', position: { x: 10, y: 10 }, size: { width: 200, height: 150 } },
      ],
    });
    expect(svg).toContain('data-container-id="empty"');
    expect(svg).toContain('Empty Region');
  });

  it('renders every member and non-member node, so membership is not lost on export', () => {
    const svg = renderToSvg(withContainers);
    for (const id of ['a', 'b', 'c']) {
      expect(svg).toContain(`data-node-id="${id}"`);
    }
  });

  it('carries no screen-only interaction affordance into the export', () => {
    // Selection highlight, drag cursor, and resize handles are canvas-only concerns.
    const svg = renderToSvg(withContainers);
    expect(svg).not.toMatch(/resize-handle|data-selected|cursor=/);
  });

  // canvas-7vs.2: a sequence `rect <color> ... end` background highlight's entire visual purpose
  // is its fill color -- previously hardcoded to 'none' regardless of container.style.fillColor.
  it('renders a container with style.fillColor set using that fill (canvas-7vs.2)', () => {
    const svg = renderToSvg({
      diagramTypeId: 'sequence',
      nodes: [],
      edges: [],
      containers: [
        {
          id: 'block1',
          label: '',
          role: 'rect',
          position: { x: 10, y: 10 },
          size: { width: 200, height: 100 },
          style: { fillColor: 'rgb(200, 150, 255)' },
        },
      ],
    });
    expect(svg).toContain('fill="rgb(200, 150, 255)"');
  });

  it('a container with no style.fillColor still falls back to fill="none" (no regression)', () => {
    const svg = renderToSvg(withContainers);
    expect(svg).toContain('<rect x="20" y="20" width="400" height="200" fill="none"');
  });
});

/**
 * canvas-7vs.1: sequence diagrams get their own dedicated lifeline/timeline rendering path
 * (renderSequenceSvg), consuming computeSequenceLayout()'s output instead of node/container
 * .position (which is always a placeholder for this family — research.md §1). These assertions
 * check real geometric relationships in the rendered markup, not just "it doesn't throw"
 * (quickstart.md's own warning about a happy-path-only suite).
 */
describe('renderToSvg: sequence diagrams (canvas-7vs.1)', () => {
  function extractLineX(svg: string, dataNodeId: string): number {
    // Each participant's <line> (the lifeline) immediately precedes its <g data-node-id="...">
    // header group in document order — see renderSequenceLifeline.
    const marker = `data-node-id="${dataNodeId}"`;
    const before = svg.slice(0, svg.indexOf(marker));
    const match = [...before.matchAll(/<line x1="([\d.]+)" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke="#888888"/g)].pop();
    if (!match) throw new Error(`no lifeline found before ${marker}`);
    return Number(match[1]);
  }

  it('renders one lifeline per participant, in declared left-to-right order', () => {
    const model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [
        { id: 'Alice', label: 'Alice', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'Bob', label: 'Bob', shape: 'rectangle', position: { x: 0, y: 0 } },
      ],
      edges: [],
      containers: [],
    };
    const svg = renderToSvg(model);
    expect(svg.match(/stroke="#888888" stroke-dasharray="4,2"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(extractLineX(svg, 'Alice')).toBeLessThan(extractLineX(svg, 'Bob'));
  });

  it('renders 4 messages between the same 2 participants at 4 distinct y-positions, in order', () => {
    const model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [
        { id: 'Alice', label: 'Alice', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'John', label: 'John', shape: 'rectangle', position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', sourceId: 'Alice', targetId: 'John', label: 'm1', sequenceOrder: 0 },
        { id: 'e2', sourceId: 'John', targetId: 'Alice', label: 'm2', sequenceOrder: 1 },
        { id: 'e3', sourceId: 'Alice', targetId: 'John', label: 'm3', sequenceOrder: 2 },
        { id: 'e4', sourceId: 'John', targetId: 'Alice', label: 'm4', sequenceOrder: 3 },
      ],
      containers: [],
    };
    const svg = renderToSvg(model);
    const ys = ['e1', 'e2', 'e3', 'e4'].map((id) => {
      const g = svg.slice(svg.indexOf(`data-edge-id="${id}"`));
      return Number(g.match(/y1="([\d.]+)"/)![1]);
    });
    expect(new Set(ys).size).toBe(4);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
    expect(ys[2]).toBeLessThan(ys[3]);
  });

  it('renders a self-message as a path loop, not a zero-length line', () => {
    const model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [{ id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'A', label: 'think', sequenceOrder: 0 }],
      containers: [],
    };
    const svg = renderToSvg(model);
    const g = svg.slice(svg.indexOf('data-edge-id="e1"'));
    expect(g).toMatch(/<path d="M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+ H [\d.]+"/);
  });

  it('renders an activate/deactivate pair as a bar on the correct participant', () => {
    const model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', label: 'go', sequenceOrder: 1 }],
      containers: [
        { id: 'act1', label: '', role: 'activate', attachedNodeIds: ['B'], position: { x: 0, y: 0 }, sequenceOrder: 0 },
        { id: 'deact1', label: '', role: 'deactivate', attachedNodeIds: ['B'], position: { x: 0, y: 0 }, sequenceOrder: 2 },
      ],
    };
    const svg = renderToSvg(model);
    expect(svg).toContain('data-container-id="act1"');
    const g = svg.slice(svg.indexOf('data-container-id="act1"'));
    expect(g).toMatch(/<rect x="[\d.]+" y="[\d.]+" width="10" height="[\d.]+" fill="#ffffff" stroke="#333333"/);
  });

  it('renders a loop block spanning only its referenced participants\' lifelines', () => {
    const model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [
        { id: 'Alice', label: 'Alice', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'Bob', label: 'Bob', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'Carol', label: 'Carol', shape: 'rectangle', position: { x: 0, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'Alice', targetId: 'Bob', label: 'ping', sequenceOrder: 1, containerId: 'loop1' }],
      containers: [{ id: 'loop1', label: 'Retry', role: 'loop', position: { x: 0, y: 0 }, sequenceOrder: 0 }],
    };
    const svg = renderToSvg(model);
    expect(svg).toContain('loop Retry');
    const carolX = extractLineX(svg, 'Carol');
    // canvas-7vs.8: loop/alt/etc get their own distinct stroke (#5b6b8c), not the plain default.
    const blockMatch = svg.match(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="none" stroke="#5b6b8c" stroke-dasharray="4,2"/);
    expect(blockMatch).toBeTruthy();
    const [, blockX, blockWidth] = blockMatch!;
    expect(Number(blockX) + Number(blockWidth)).toBeLessThan(carolX);
  });
});

/**
 * canvas-7vs.8: every DiagramContainer.role used to render as the exact same generic dashed gray
 * box (confirmed: renderContainer never read container.role at all). canvas-7vs.9: attachedNodeIds
 * was parsed/modeled but neither renderer drew anything for it. These assert real per-role visual
 * differences and real connector geometry, not just "it doesn't throw".
 */
describe('renderToSvg: container role styling (canvas-7vs.8) and attachment connectors (canvas-7vs.9)', () => {
  it('a sequence Note gets a pale-yellow fill and a connector line to its participant\'s lifeline', () => {
    const model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [{ id: 'Bob', label: 'Bob', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [{ id: 'note1', label: 'hi', role: 'note-right', attachedNodeIds: ['Bob'], position: { x: 0, y: 0 }, size: { width: 100, height: 50 }, sequenceOrder: 0 }],
    };
    const svg = renderToSvg(model);
    const g = svg.slice(svg.indexOf('data-container-id="note1"'));
    expect(g).toContain('fill="#fff9c4"');
    expect(g).toMatch(/<line x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke="#999999" stroke-dasharray="2,2"/);
  });

  it('a sequence box grouping gets a finer dash than a control-flow block', () => {
    const model: DiagramModel = {
      diagramTypeId: 'sequence',
      nodes: [{ id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, containerId: 'box1' }],
      edges: [],
      containers: [{ id: 'box1', label: 'Team', role: 'box', position: { x: 0, y: 0 } }],
    };
    const svg = renderToSvg(model);
    const g = svg.slice(svg.indexOf('data-container-id="box1"'));
    expect(g).toContain('stroke-dasharray="2,3"');
  });

  it('a UML namespace gets a header band, distinct from the plain default box', () => {
    const model: DiagramModel = {
      diagramTypeId: 'uml',
      nodes: [],
      edges: [],
      containers: [{ id: 'ns1', label: 'Models', role: 'namespace', position: { x: 10, y: 10 }, size: { width: 200, height: 150 } }],
    };
    const svg = renderToSvg(model);
    const g = svg.slice(svg.indexOf('data-container-id="ns1"'));
    // Outer box (fill #f7f7f7) plus a second, header-band rect tinting the top strip.
    expect(g).toContain('fill="#f7f7f7"');
    expect(g.match(/<rect/g)?.length).toBe(2);
  });

  it('a UML note (role: note) gets the same pale-yellow treatment as a sequence note, plus a connector to its class', () => {
    const model: DiagramModel = {
      diagramTypeId: 'uml',
      nodes: [{ id: 'Foo', label: 'Foo', shape: 'rectangle', position: { x: 300, y: 300 } }],
      edges: [],
      containers: [{ id: 'note1', label: 'a note', role: 'note', attachedNodeIds: ['Foo'], position: { x: 10, y: 10 }, size: { width: 100, height: 50 } }],
    };
    const svg = renderToSvg(model);
    const g = svg.slice(svg.indexOf('data-container-id="note1"'));
    expect(g).toContain('fill="#fff9c4"');
    expect(g).toMatch(/<line x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+" stroke="#999999" stroke-dasharray="2,2"/);
  });

  it('a standalone UML note (no attachedNodeIds) draws no connector line at all', () => {
    const model: DiagramModel = {
      diagramTypeId: 'uml',
      nodes: [],
      edges: [],
      containers: [{ id: 'note1', label: 'standalone', role: 'note', attachedNodeIds: [], position: { x: 10, y: 10 }, size: { width: 100, height: 50 } }],
    };
    const svg = renderToSvg(model);
    const g = svg.slice(svg.indexOf('data-container-id="note1"'));
    expect(g).not.toContain('<line');
  });

  it('a container with no role (e.g. a flowchart subgraph or C4 boundary) keeps the plain default box (no regression)', () => {
    const model: DiagramModel = {
      diagramTypeId: 'flowchart',
      nodes: [],
      edges: [],
      containers: [{ id: 'sg1', label: 'Group', position: { x: 10, y: 10 }, size: { width: 100, height: 50 } }],
    };
    const svg = renderToSvg(model);
    const g = svg.slice(svg.indexOf('data-container-id="sg1"'));
    expect(g).toContain('fill="none" stroke="#888888" stroke-dasharray="6,4"');
  });
});

/**
 * Feature 009: the seven additional Mermaid flowchart shapes (plus double-circle and stadium,
 * both already implied by the DSL but never drawn) must render as themselves in export markup —
 * never silently fall through to the rectangle `default` case (data-model.md's rendering table).
 */
describe('renderToSvg additional node shapes (feature 009)', () => {
  function svgFor(shape: DiagramModel['nodes'][number]['shape']): string {
    return renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: 'Node', shape, position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    });
  }

  it('renders stadium as a fully rounded rect (rx/ry = half the node height), distinct from rounded-rectangle', () => {
    const svg = svgFor('stadium');
    expect(svg).toContain('<rect');
    expect(svg).toMatch(/<rect[^>]*rx="30"[^>]*ry="30"/);
  });

  it('renders subroutine as a rect with two inset vertical lines', () => {
    const svg = svgFor('subroutine');
    expect(svg).toContain('<rect');
    expect(svg.match(/<line/g)?.length).toBe(2);
  });

  it('renders double-circle as two concentric ellipses', () => {
    const svg = svgFor('double-circle');
    expect(svg.match(/<ellipse/g)?.length).toBe(2);
  });

  it('renders hexagon as a six-point polygon', () => {
    const svg = svgFor('hexagon');
    const match = svg.match(/<polygon points="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].trim().split(/\s+/)).toHaveLength(6);
  });

  it.each(['parallelogram', 'parallelogram-alt', 'trapezoid', 'trapezoid-alt'] as const)(
    'renders %s as a four-point polygon',
    (shape) => {
      const svg = svgFor(shape);
      const match = svg.match(/<polygon points="([^"]+)"/);
      expect(match).not.toBeNull();
      expect(match![1].trim().split(/\s+/)).toHaveLength(4);
    },
  );

  it('renders parallelogram and parallelogram-alt as mirror images (opposite slant)', () => {
    const svg = svgFor('parallelogram');
    const svgAlt = svgFor('parallelogram-alt');
    const points = svg.match(/<polygon points="([^"]+)"/)![1];
    const pointsAlt = svgAlt.match(/<polygon points="([^"]+)"/)![1];
    expect(points).not.toBe(pointsAlt);
  });

  it('renders asymmetric as a polygon, not a rectangle', () => {
    const svg = svgFor('asymmetric');
    expect(svg).toContain('<polygon');
    expect(svg).not.toContain('<rect');
  });

  it('never falls through to a plain rectangle default for any of the nine new shapes', () => {
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
    const rectangleSvg = svgFor('rectangle');
    for (const shape of newShapes) {
      expect(svgFor(shape)).not.toBe(rectangleSvg);
    }
  });
});

/**
 * linkStyle support: an edge carrying a style must render with that color/width/dash-pattern
 * instead of the hardcoded default stroke every edge used to get regardless of edge.style.
 */
describe('renderToSvg edge styling (linkStyle)', () => {
  function svgForEdge(style: DiagramModel['edges'][number]['style']): string {
    return renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', style }],
      containers: [],
    });
  }

  it('applies a styled edge\'s stroke color instead of the default', () => {
    const svg = svgForEdge({ strokeColor: '#ff0000' });
    expect(svg).toMatch(/<line[^>]*stroke="#ff0000"/);
    expect(svg).not.toMatch(/<line[^>]*stroke="#333333"/);
  });

  it('applies stroke-width when set', () => {
    const svg = svgForEdge({ strokeWidth: 4 });
    expect(svg).toMatch(/<line[^>]*stroke-width="4"/);
  });

  it('applies stroke-dasharray when set', () => {
    const svg = svgForEdge({ strokeDasharray: '5 5' });
    expect(svg).toMatch(/<line[^>]*stroke-dasharray="5 5"/);
  });

  it('falls back to the default stroke and no dasharray for an unstyled edge', () => {
    const svg = svgForEdge(undefined);
    expect(svg).toMatch(/<line[^>]*stroke="#333333"/);
    expect(svg).not.toContain('stroke-dasharray');
  });
});

/**
 * Grouping B: dotted/thick/invisible/no-arrow/bidirectional edges must actually look distinct —
 * not just round-trip as data. `edge.style`'s explicit overrides (linkStyle) still win over these
 * declared-lineStyle defaults, since linkStyle is a more specific instruction layered on top.
 */
describe('renderToSvg edge line style and arrow direction (grouping B)', () => {
  function svgForConnector(edge: Partial<DiagramModel['edges'][number]>): string {
    return renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', ...edge }],
      containers: [],
    });
  }

  it('gives a dotted edge a default stroke-dasharray', () => {
    const svg = svgForConnector({ lineStyle: 'dotted' });
    expect(svg).toMatch(/<line[^>]*stroke-dasharray="[^"]+"/);
  });

  it('gives a thick edge a wider default stroke than a plain edge', () => {
    const plain = svgForConnector({});
    const thick = svgForConnector({ lineStyle: 'thick' });
    const plainWidth = Number(plain.match(/<line[^>]*stroke-width="(\d+)"/)?.[1] ?? 1);
    const thickWidth = Number(thick.match(/<line[^>]*stroke-width="(\d+)"/)?.[1] ?? 1);
    expect(thickWidth).toBeGreaterThan(plainWidth);
  });

  it('an explicit linkStyle stroke-dasharray overrides a dotted lineStyle\'s default dasharray', () => {
    const svg = svgForConnector({ lineStyle: 'dotted', style: { strokeDasharray: '9 1' } });
    expect(svg).toMatch(/<line[^>]*stroke-dasharray="9 1"/);
  });

  it('renders an invisible edge with no visible stroke and no arrowhead', () => {
    const svg = svgForConnector({ lineStyle: 'invisible' });
    expect(svg).not.toMatch(/marker-end/);
    expect(svg).toMatch(/<line[^>]*stroke="none"/);
  });

  it('omits the arrowhead marker for a no-arrow edge (---)', () => {
    const svg = svgForConnector({ arrow: 'none' });
    expect(svg).not.toMatch(/marker-end/);
  });

  it('adds a marker-start (in addition to marker-end) for a bidirectional edge', () => {
    const svg = svgForConnector({ arrow: 'both' });
    expect(svg).toMatch(/marker-start/);
    expect(svg).toMatch(/marker-end/);
  });

  it('a plain edge (no lineStyle/arrow set) still gets exactly one arrowhead, as before', () => {
    const svg = svgForConnector({});
    expect(svg).toMatch(/marker-end/);
    expect(svg).not.toMatch(/marker-start/);
  });
});

/**
 * Grouping F (docs/flowchart-completeness-brief.md): a `<br/>` (any case, self-closing or not) or
 * a raw newline in a label must render as an actual line break (stacked `<tspan>`s), not literal
 * text. The label text itself already round-trips (label capture is a greedy `.+`) — this is a
 * rendering-only change, so there is no parser/model/round-trip test for it.
 */
describe('renderToSvg multi-line labels (grouping F)', () => {
  function svgForNodeLabel(label: string): string {
    return renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label, shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    });
  }

  it('renders a single-line label exactly as before (no tspan wrapping)', () => {
    const svg = svgForNodeLabel('Plain Label');
    expect(svg).toContain('>Plain Label</text>');
    expect(svg).not.toContain('<tspan');
  });

  it.each(['<br/>', '<br>', '<br />', '<BR/>'])('splits a label containing "%s" into two tspans', (br) => {
    const svg = svgForNodeLabel(`Line one${br}Line two`);
    expect(svg).toMatch(/<tspan[^>]*>Line one<\/tspan>/);
    expect(svg).toMatch(/<tspan[^>]*>Line two<\/tspan>/);
  });

  it('splits a label containing a literal newline into two tspans', () => {
    const svg = svgForNodeLabel('Line one\nLine two');
    expect(svg).toMatch(/<tspan[^>]*>Line one<\/tspan>/);
    expect(svg).toMatch(/<tspan[^>]*>Line two<\/tspan>/);
  });

  it('escapes XML-sensitive characters within each line of a multi-line label', () => {
    const svg = svgForNodeLabel('A & B<br/><C>');
    expect(svg).toMatch(/<tspan[^>]*>A &amp; B<\/tspan>/);
    expect(svg).toMatch(/<tspan[^>]*>&lt;C&gt;<\/tspan>/);
  });

  it('splits an edge label the same way as a node label', () => {
    const svg = renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', label: 'Edge one<br/>Edge two' }],
      containers: [],
    });
    expect(svg).toMatch(/<tspan[^>]*>Edge one<\/tspan>/);
    expect(svg).toMatch(/<tspan[^>]*>Edge two<\/tspan>/);
  });

  it('preserves a three-line label in declared order', () => {
    const svg = svgForNodeLabel('First<br/>Second<br/>Third');
    const order = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
    expect(order).toEqual(['First', 'Second', 'Third']);
  });
});

/**
 * canvas-3zb: a label wider than its node's own box (most commonly an icon's displayName, e.g.
 * "Azure Storage Accounts") previously overflowed both edges uncontained -- `splitLabelLines`
 * gained optional `maxWidth`/`fontSize` params to word-wrap a too-long line, on top of (not
 * instead of) grouping F's own explicit-break splitting above.
 */
describe('splitLabelLines word-wrap (canvas-3zb)', () => {
  it('returns the label unchanged when maxWidth/fontSize are omitted (backward compatible)', () => {
    expect(splitLabelLines('Azure Storage Accounts')).toEqual(['Azure Storage Accounts']);
  });

  it('does not wrap a label that already fits within maxWidth', () => {
    expect(splitLabelLines('Short', 200, 14)).toEqual(['Short']);
  });

  it('wraps a label wider than maxWidth onto multiple lines', () => {
    const lines = splitLabelLines('Azure Storage Accounts', 124, 14);
    expect(lines.length).toBeGreaterThan(1);
    // Every line individually fits the same width budget the wrap decision was made against.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(Math.floor(124 / (14 * 0.56)));
    }
  });

  it('never drops or reorders words while wrapping', () => {
    const label = 'Azure Data Virtualization Gateway Service';
    const lines = splitLabelLines(label, 100, 14);
    expect(lines.join(' ')).toBe(label);
  });

  it('does not split a single word wider than maxWidth (overflows rather than breaking mid-word)', () => {
    const lines = splitLabelLines('Supercalifragilisticexpialidocious', 40, 14);
    expect(lines).toEqual(['Supercalifragilisticexpialidocious']);
  });

  it('word-wraps each explicit-break line independently, combining with grouping F', () => {
    const lines = splitLabelLines('Azure Storage Accounts<br/>Second Explicit Line', 124, 14);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ')).toBe('Azure Storage Accounts Second Explicit Line');
  });

  it('renderToSvg wraps an icon node label too wide for its box into multiple tspans', () => {
    const svg = renderToSvg(
      {
        diagramTypeId: 'flowchart',
        nodes: [
          {
            id: 'A',
            label: 'Azure Storage Accounts',
            shape: 'icon',
            position: { x: 0, y: 0 },
            icon: { libraryId: 'azure-icons', libraryVersion: '2024.1', iconId: 'storage-accounts' },
          },
        ],
        edges: [],
        containers: [],
      },
      () => '<rect width="48" height="48" />', // minimal resolveIcon so the icon render branch is actually taken
    );
    const tspanTexts = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
    expect(tspanTexts.length).toBeGreaterThan(1);
    expect(tspanTexts.join(' ')).toBe('Azure Storage Accounts');
  });

  it('renderToSvg leaves a short label single-line and unwrapped', () => {
    const svg = renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [{ id: 'A', label: 'Start', shape: 'rectangle', position: { x: 0, y: 0 } }],
      edges: [],
      containers: [],
    });
    expect(svg).toContain('>Start</text>');
    expect(svg).not.toContain('<tspan');
  });
});

/**
 * canvas-1rq: edges drawn center-to-center hide the arrowhead (and the marker itself) underneath
 * the opaque target node. Endpoints must be clipped to each node's shape boundary, not left at the
 * raw center, so the arrowhead lands in open space between the two shapes.
 */
describe('renderToSvg edge endpoint clipping (canvas-1rq)', () => {
  function lineCoords(svg: string): { x1: number; y1: number; x2: number; y2: number } {
    const match = svg.match(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/);
    expect(match, `no <line> found in: ${svg}`).not.toBeNull();
    const [, x1, y1, x2, y2] = match!;
    return { x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2) };
  }

  it('clips a horizontal edge between two rectangles to each node\'s edge, not its center', () => {
    // A[0,0 140x60] center (70,30); B[300,0 140x60] center (370,30).
    const svg = renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B' }],
      containers: [],
    });
    const { x1, x2, y1, y2 } = lineCoords(svg);
    expect(x1).toBeCloseTo(140); // A's right edge, not its center (70)
    expect(x2).toBeCloseTo(300); // B's left edge, not its center (370)
    expect(y1).toBeCloseTo(30);
    expect(y2).toBeCloseTo(30);
  });

  it('clips a diagonal edge between two rectangles differently than an ellipse or diamond would', () => {
    const nodesFor = (shape: 'rectangle' | 'circle' | 'diamond') => [
      { id: 'A', label: 'A', shape, position: { x: -100, y: -50 }, size: { width: 200, height: 100 } },
      { id: 'B', label: 'B', shape, position: { x: 100, y: 100 }, size: { width: 200, height: 100 } },
    ];
    const svgFor = (shape: 'rectangle' | 'circle' | 'diamond') =>
      renderToSvg({
        diagramTypeId: 'flowchart',
        nodes: nodesFor(shape) as never,
        edges: [{ id: 'e1', sourceId: 'A', targetId: 'B' }],
        containers: [],
      });

    const rect = lineCoords(svgFor('rectangle'));
    const circle = lineCoords(svgFor('circle'));
    const diamond = lineCoords(svgFor('diamond'));

    // All three must actually clip away from center (0,0) — none should start at the raw center.
    expect(rect.x1).not.toBeCloseTo(0);
    expect(circle.x1).not.toBeCloseTo(0);
    expect(diamond.x1).not.toBeCloseTo(0);
    // But each shape's boundary differs, so the three must disagree with each other.
    expect(rect.x1).not.toBeCloseTo(circle.x1);
    expect(circle.x1).not.toBeCloseTo(diamond.x1);
    expect(rect.x1).not.toBeCloseTo(diamond.x1);
  });

  it('never extends an endpoint past the other node\'s own center, even when nodes nearly overlap', () => {
    const svg = renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 10, y: 0 }, size: { width: 200, height: 100 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B' }],
      containers: [],
    });
    const { x1, x2 } = lineCoords(svg);
    // Centers are at 100 and 110 respectively; neither endpoint may cross past the other's center.
    expect(x1).toBeLessThanOrEqual(110);
    expect(x2).toBeGreaterThanOrEqual(100);
  });

  it('still renders a visible marker-end for a plain edge after clipping', () => {
    const svg = renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B' }],
      containers: [],
    });
    expect(svg).toMatch(/<line[^>]*marker-end="url\(#arrowhead\)"/);
  });
});

/**
 * canvas-23t.5: an icon node with no explicit `node.size` used to fall back to the flat
 * DEFAULT_NODE_SIZE (140x60) — built for a short text label, not an icon glyph plus a caption
 * that (for real library icon names, e.g. "Azure Data Lake Storage Gen1") routinely wraps to two
 * or three lines. `iconNodeSize` now derives a content-fit box whose height grows with however
 * many lines the caption actually wraps into, computed with the same `splitLabelLines` heuristic
 * used to render it. An explicit `node.size` (user resize) still always wins.
 */
describe('iconNodeSize / nodeSize content-fit box (canvas-23t.5)', () => {
  function iconNode(label: string, overrides: Partial<DiagramNode> = {}): DiagramNode {
    return {
      id: 'A',
      label,
      shape: 'icon',
      position: { x: 0, y: 0 },
      icon: { libraryId: 'azure-icons', libraryVersion: '2024.1', iconId: 'storage-accounts' },
      ...overrides,
    };
  }

  it('gives a longer, multi-line-wrapping label a taller box than a short one-line label', () => {
    const shortSize = nodeSize(iconNode('VM'));
    const longSize = nodeSize(iconNode('Azure Data Lake Storage Gen1 Extended Analytics Workspace'));
    expect(longSize.height).toBeGreaterThan(shortSize.height);
    // Width is a fixed content-fit budget regardless of label length -- only height grows with
    // however many lines the label actually wraps into.
    expect(longSize.width).toBe(shortSize.width);
  });

  it('nodeSize delegates to iconNodeSize exactly for an unsized icon node', () => {
    const node = iconNode('Azure Storage Accounts');
    expect(nodeSize(node)).toEqual(iconNodeSize(node));
  });

  it('an explicit node.size always wins over the content-fit calculation', () => {
    const node = iconNode('Azure Data Lake Storage Gen1 Extended Long Caption', {
      size: { width: 999, height: 5 },
    });
    expect(nodeSize(node)).toEqual({ width: 999, height: 5 });
  });

  it('leaves a non-icon shape node completely unaffected: flat DEFAULT_NODE_SIZE unless sized', () => {
    const rect: DiagramNode = {
      id: 'B',
      label: 'A Rectangle With A Fairly Long Label Too, For Comparison',
      shape: 'rectangle',
      position: { x: 0, y: 0 },
    };
    expect(nodeSize(rect)).toEqual({ width: 140, height: 60 });

    const sizedRect: DiagramNode = { ...rect, size: { width: 200, height: 80 } };
    expect(nodeSize(sizedRect)).toEqual({ width: 200, height: 80 });
  });
});

/**
 * canvas-23t.5 continued: the rendered SVG itself must actually stay within the content-fit box
 * `iconNodeSize` computes -- no caption `<tspan>` may render past the node's own `<rect>` height.
 */
describe('renderToSvg icon node caption fits its content-fit box (canvas-23t.5)', () => {
  const resolveIcon = () => '<rect width="48" height="48" />'; // minimal markup so the icon render branch is taken

  function svgForIconLabel(label: string): string {
    return renderToSvg(
      {
        diagramTypeId: 'flowchart',
        nodes: [
          {
            id: 'A',
            label,
            shape: 'icon',
            position: { x: 0, y: 0 },
            icon: { libraryId: 'azure-icons', libraryVersion: '2024.1', iconId: 'data-lake' },
          },
        ],
        edges: [],
        containers: [],
      },
      resolveIcon,
    );
  }

  it("keeps every rendered caption line within the node's own box height for a long wrapping label", () => {
    const longLabel = 'Azure Data Lake Storage Gen1 Extended Analytics Workspace';
    const svg = svgForIconLabel(longLabel);

    const rectMatch = svg.match(/<rect x="0" y="0" width="[\d.]+" height="([\d.]+)"/);
    expect(rectMatch, `no node box rect found in: ${svg}`).not.toBeNull();
    const boxHeight = Number(rectMatch![1]);

    const textMatch = svg.match(
      /<text x="[\d.-]+" y="([\d.-]+)" text-anchor="middle" font-size="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/,
    );
    expect(textMatch, `no caption <text> found in: ${svg}`).not.toBeNull();
    const baseY = Number(textMatch![1]);
    const fontSize = Number(textMatch![2]);
    const dyValues = [...textMatch![3].matchAll(/dy="(-?[\d.]+)em"/g)].map((m) => Number(m[1]));
    // Confirms this label really did wrap to multiple lines, not a false-positive pass on a
    // single-line label that trivially "fits".
    expect(dyValues.length).toBeGreaterThan(1);

    const lastLineY = dyValues.reduce((y, dy) => y + dy * fontSize, baseY);
    expect(lastLineY).toBeLessThanOrEqual(boxHeight);
  });

  it('renders a short single-line icon label as one tspan-free line with no unnecessary extra height', () => {
    const svg = svgForIconLabel('VM');

    // Icon glyph itself is drawn.
    expect(svg).toContain('<rect width="48" height="48" />');

    const textMatch = svg.match(
      /<text x="[\d.-]+" y="[\d.-]+" text-anchor="middle" font-size="[\d.]+"[^>]*>([\s\S]*?)<\/text>/,
    );
    expect(textMatch, `no caption <text> found in: ${svg}`).not.toBeNull();
    expect(textMatch![1]).not.toContain('<tspan');
    expect(textMatch![1]).toContain('VM');

    // Box height matches the exact single-line content-fit size -- no leftover flat-default
    // padding carried over from the old DEFAULT_NODE_SIZE fallback.
    const node: DiagramNode = {
      id: 'A',
      label: 'VM',
      shape: 'icon',
      position: { x: 0, y: 0 },
      icon: { libraryId: 'azure-icons', libraryVersion: '2024.1', iconId: 'data-lake' },
    };
    const expectedHeight = iconNodeSize(node).height;
    const rectMatch = svg.match(/<rect x="0" y="0" width="[\d.]+" height="([\d.]+)"/);
    expect(rectMatch, `no node box rect found in: ${svg}`).not.toBeNull();
    expect(Number(rectMatch![1])).toBeCloseTo(expectedHeight);
  });
});

/**
 * canvas-x66: an ER entity's `attributes` (EntityAttribute[]) or a UML class's `members`
 * (ClassMember[]) were parsed and modeled correctly but never rendered — every entity/class drew
 * as a bare labeled box, indistinguishable from one with no body at all. `tableNodeLayout` now
 * returns real row geometry for a node carrying either field, and `renderNode` draws a header
 * band + divider + one `<text>` row per attribute/member instead of falling through to the plain
 * centered-label case.
 */
describe('renderToSvg ER attribute / UML member table body (canvas-x66)', () => {
  function entityNode(overrides: Partial<DiagramNode> = {}): DiagramNode {
    return {
      id: 'CUSTOMER',
      label: 'CUSTOMER',
      shape: 'rectangle',
      position: { x: 0, y: 0 },
      ...overrides,
    };
  }

  function classNode(overrides: Partial<DiagramNode> = {}): DiagramNode {
    return {
      id: 'Animal',
      label: 'Animal',
      shape: 'rectangle',
      position: { x: 0, y: 0 },
      ...overrides,
    };
  }

  function svgForNode(node: DiagramNode): string {
    return renderToSvg({
      diagramTypeId: 'erd',
      nodes: [node],
      edges: [],
      containers: [],
    });
  }

  it('renders a divider line and one <text> row per ER attribute, correctly formatted', () => {
    const node = entityNode({
      attributes: [
        { type: 'string', name: 'id', keys: ['PK'] },
        { type: 'string', name: 'email', keys: ['UK', 'FK'] },
        { type: 'string', name: 'name', keys: [] },
      ],
    });
    const svg = svgForNode(node);

    // Exactly one divider line under the header band, no other <line> in a node-only model.
    expect(svg.match(/<line/g)?.length).toBe(1);

    expect(svg).toContain('>string id PK<');
    expect(svg).toContain('>string email UK, FK<');
    expect(svg).toContain('>string name<');
    // The keyless row must not carry a stray trailing space where the keys part would have gone.
    expect(svg).not.toContain('>string name <');
  });

  // Corrects an earlier wrong assumption in this same session that Mermaid's own attribute
  // comments (a trailing quoted string, e.g. `string id PK "the primary key"`) are metadata-only
  // and never rendered — confirmed against Mermaid's real erRenderer.js source that they DO draw
  // as their own rightmost column, after type/name/key. Live-reported: a real diagram with
  // comments on several attributes showed none of them on the canvas.
  it('renders an attribute comment as trailing text in its row, after type/name/keys', () => {
    const node = entityNode({
      attributes: [
        { type: 'string', name: 'email', keys: ['UK'], comment: 'Used for login' },
        { type: 'string', name: 'name', keys: [], comment: 'Basic, Standard or Premium' },
        { type: 'string', name: 'id', keys: ['PK'] },
      ],
    });
    const svg = svgForNode(node);

    expect(svg).toContain('>string email UK &quot;Used for login&quot;<');
    expect(svg).toContain('>string name &quot;Basic, Standard or Premium&quot;<');
    // A comment-less row is completely unaffected — no stray quote marks.
    expect(svg).toContain('>string id PK<');
    expect(svg).not.toContain('id PK &quot;');
  });

  it('renders one <text> row per UML member, formatting an attribute and a method differently', () => {
    const node = classNode({
      members: [
        { kind: 'attribute', visibility: '+', type: 'String', name: 'name' },
        { kind: 'method', visibility: '+', name: 'makeSound', params: '', returnType: 'void' },
        { kind: 'attribute', visibility: '-', type: 'int', name: 'age', isStatic: true },
        { kind: 'method', visibility: '#', name: 'clone', params: '', isAbstract: true },
      ],
    });
    const svg = svgForNode(node);

    expect(svg.match(/<line/g)?.length).toBe(1);
    expect(svg).toContain('>+String name<');
    expect(svg).toContain('>+makeSound() void<');
    expect(svg).toContain('>-int age$<');
    expect(svg).toContain('>#clone()*<');
  });

  // canvas-7vs.4: a UML <<Stereotype>> annotation was parsed and modeled (umlStereotype) but
  // never drawn anywhere -- both renderers just showed the plain class name with no indication a
  // class carried an <<Interface>>/<<Abstract>>/etc annotation at all.
  it('renders umlStereotype as its own line above the class name (canvas-7vs.4)', () => {
    const node = classNode({
      umlStereotype: 'Interface',
      members: [{ kind: 'method', visibility: '+', name: 'draw', params: '', returnType: 'void' }],
    });
    const svg = svgForNode(node);
    expect(svg).toContain('&lt;&lt;Interface&gt;&gt;');
    expect(svg).toContain('>Animal<'); // classNode()'s default label -- still drawn, unaffected
  });

  it('a class with no umlStereotype renders no stray annotation text (no regression)', () => {
    const node = classNode({
      members: [{ kind: 'method', visibility: '+', name: 'draw', params: '', returnType: 'void' }],
    });
    const svg = svgForNode(node);
    expect(svg).not.toContain('&lt;&lt;');
  });

  it('a class with a stereotype is taller than the same class without one (room for the annotation line)', () => {
    const members = [{ kind: 'method' as const, visibility: '+' as const, name: 'draw', params: '', returnType: 'void' }];
    const plainHeight = nodeSize(classNode({ members })).height;
    const annotatedHeight = nodeSize(classNode({ umlStereotype: 'Interface', members })).height;
    expect(annotatedHeight).toBeGreaterThan(plainHeight);
  });

  it('grows box height proportionally to row count', () => {
    const twoRows = entityNode({
      attributes: [
        { type: 'string', name: 'id', keys: ['PK'] },
        { type: 'string', name: 'name', keys: [] },
      ],
    });
    const fiveRows = entityNode({
      id: 'ORDER',
      label: 'ORDER',
      attributes: [
        { type: 'string', name: 'id', keys: ['PK'] },
        { type: 'string', name: 'a', keys: [] },
        { type: 'string', name: 'b', keys: [] },
        { type: 'string', name: 'c', keys: [] },
        { type: 'string', name: 'd', keys: [] },
      ],
    });

    const twoRowsSize = nodeSize(twoRows);
    const fiveRowsSize = nodeSize(fiveRows);
    expect(fiveRowsSize.height).toBeGreaterThan(twoRowsSize.height);

    // Row height is fixed per row (independent of row count), so three extra rows must add
    // exactly three rows' worth of height -- not some unrelated amount.
    const twoRowsLayout = tableNodeLayout(twoRows)!;
    const perRowHeight = twoRowsLayout.rows[1].y - twoRowsLayout.rows[0].y;
    expect(perRowHeight).toBeGreaterThan(0);
    expect(fiveRowsSize.height - twoRowsSize.height).toBeCloseTo(perRowHeight * 3);

    const svgTwo = svgForNode(twoRows);
    const svgFive = svgForNode(fiveRows);
    const heightOf = (svg: string) => {
      const match = svg.match(/<rect x="0" y="0" width="[\d.]+" height="([\d.]+)"/);
      expect(match, `no node box rect found in: ${svg}`).not.toBeNull();
      return Number(match![1]);
    };
    expect(heightOf(svgFive)).toBeGreaterThan(heightOf(svgTwo));
  });

  it('renders an EMPTY attributes array identically to a node with the field entirely absent', () => {
    const withEmptyArray = entityNode({ attributes: [] });
    const { attributes: _omit, ...rest } = withEmptyArray;
    const withFieldAbsent = entityNode(rest);
    expect(svgForNode(withEmptyArray)).toBe(svgForNode(withFieldAbsent));
  });

  it('renders an EMPTY members array identically to a node with the field entirely absent', () => {
    const withEmptyArray = classNode({ members: [] });
    const { members: _omit, ...rest } = withEmptyArray;
    const withFieldAbsent = classNode(rest);
    expect(svgForNode(withEmptyArray)).toBe(svgForNode(withFieldAbsent));
  });

  it('a node with no attributes/members renders exactly like the pre-existing plain-label case: no divider, one centered <text>', () => {
    const plain = classNode();
    const svg = svgForNode(plain);
    expect(svg).not.toMatch(/<line/);
    expect(svg.match(/<text/g)?.length).toBe(1);
    expect(svg).toContain('>Animal</text>');
    expect(svg).toMatch(/dominant-baseline="middle"/);
  });

  it('an explicit node.size on a table node is respected, not overridden by the content-fit calculation', () => {
    const node = entityNode({
      size: { width: 500, height: 40 },
      attributes: [
        { type: 'string', name: 'id', keys: ['PK'] },
        { type: 'string', name: 'name', keys: [] },
        { type: 'string', name: 'email', keys: [] },
      ],
    });
    expect(nodeSize(node)).toEqual({ width: 500, height: 40 });
    const layout = tableNodeLayout(node);
    expect(layout).not.toBeNull();
    expect(layout!.width).toBe(500);
    expect(layout!.height).toBe(40);
  });

  it('tableNodeLayout returns null for a node with no attributes/members', () => {
    expect(tableNodeLayout(entityNode())).toBeNull();
    expect(tableNodeLayout(entityNode({ attributes: [] }))).toBeNull();
    expect(tableNodeLayout(classNode({ members: [] }))).toBeNull();
  });

  it('tableNodeLayout returns one row entry per attribute, in declaration order, with formatted text', () => {
    const node = entityNode({
      attributes: [
        { type: 'string', name: 'id', keys: ['PK'] },
        { type: 'int', name: 'age', keys: [] },
      ],
    });
    const layout = tableNodeLayout(node);
    expect(layout).not.toBeNull();
    expect(layout!.rows.map((r) => r.text)).toEqual(['string id PK', 'int age']);
    // Row y-positions strictly increase with declaration order (stacked downward).
    expect(layout!.rows[1].y).toBeGreaterThan(layout!.rows[0].y);
    // Divider sits above every row.
    expect(layout!.dividerY).toBeLessThan(layout!.rows[0].y);
  });

  it('nodeSize prefers members over attributes only when a node (invalidly) has both -- attributes wins, matching tableRows\' own precedence', () => {
    // Not a real-world case (ER and UML are mutually exclusive diagram families), but pins down
    // tableRows' documented behavior rather than leaving it as an accidental implementation detail.
    const node = entityNode({
      attributes: [{ type: 'string', name: 'id', keys: [] }],
      members: [{ kind: 'attribute', name: 'ignored' }],
    });
    const layout = tableNodeLayout(node);
    expect(layout!.rows.map((r) => r.text)).toEqual(['string id']);
  });
});

/**
 * canvas-2ut: an ER relationship's crow's-foot cardinality tokens (`erSourceCardinality`/
 * `erTargetCardinality`) were parsed but never drawn — every relationship rendered a generic
 * arrowhead, indistinguishable from a plain flowchart edge (see erd-attributes.test.ts's own
 * coverage of the parse/serialize half of this fix — the token also used to be silently
 * normalized to the default `||--o{` on every re-save regardless of what was actually specified).
 * This covers the render half: `cardinalityGlyphs`' own geometry, and that `renderToSvg` draws it
 * INSTEAD OF the generic arrowhead for a cardinality-bearing edge, while leaving every other edge
 * completely unaffected (the critical regression-safety case).
 */
describe('cardinalityGlyphs geometry (canvas-2ut)', () => {
  const point = { x: 0, y: 0 };

  it("produces a single perpendicular tick glyph for a '|' token, centered on point", () => {
    const glyphs: CardinalityGlyph[] = cardinalityGlyphs(point, 1, 0, '|');
    expect(glyphs).toHaveLength(1);
    const [glyph] = glyphs;
    expect(glyph.kind).toBe('tick');
    if (glyph.kind !== 'tick') return;
    // The first character of a token is drawn right at `point` (distance 0 along the direction) —
    // the tick's own midpoint must coincide with it.
    expect((glyph.x1 + glyph.x2) / 2).toBeCloseTo(point.x);
    expect((glyph.y1 + glyph.y2) / 2).toBeCloseTo(point.y);
    // Perpendicular to the direction vector (1, 0): the tick's own vector must have zero dot
    // product with the direction.
    const tickDx = glyph.x2 - glyph.x1;
    const tickDy = glyph.y2 - glyph.y1;
    expect(tickDx * 1 + tickDy * 0).toBeCloseTo(0);
    // Non-degenerate: the tick actually has visible length.
    expect(Math.hypot(tickDx, tickDy)).toBeGreaterThan(0);
  });

  it("produces a single hollow-circle glyph for an 'o' token, offset outward from point", () => {
    const glyphs: CardinalityGlyph[] = cardinalityGlyphs(point, 1, 0, 'o');
    expect(glyphs).toHaveLength(1);
    const [glyph] = glyphs;
    expect(glyph.kind).toBe('circle');
    if (glyph.kind !== 'circle') return;
    expect(glyph.r).toBeGreaterThan(0);
    // The circle's own center sits its own radius away from `point` along the direction — offset
    // outward, not drawn exactly on the node boundary.
    const distFromPoint = Math.hypot(glyph.cx - point.x, glyph.cy - point.y);
    expect(distFromPoint).toBeCloseTo(glyph.r);
  });

  it.each(['{', '}'])("produces a three-pronged fork glyph for a '%s' token", (ch) => {
    const glyphs: CardinalityGlyph[] = cardinalityGlyphs(point, 1, 0, ch);
    expect(glyphs).toHaveLength(1);
    const [glyph] = glyphs;
    expect(glyph.kind).toBe('fork');
    if (glyph.kind !== 'fork') return;
    expect(glyph.prongs).toHaveLength(3);
    // The apex opens outward: it sits further from `point` than any of the three prong bases.
    const apexDist = Math.hypot(glyph.apexX - point.x, glyph.apexY - point.y);
    for (const prong of glyph.prongs) {
      const prongDist = Math.hypot(prong.x - point.x, prong.y - point.y);
      expect(apexDist).toBeGreaterThan(prongDist);
    }
    // A real spread, not three coincident points collapsed to one.
    const distinctPoints = new Set(glyph.prongs.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    expect(distinctPoints.size).toBe(3);
  });

  it('reads a two-character token nearest-node-first: index 0 sits closer to point than index 1', () => {
    const glyphs: CardinalityGlyph[] = cardinalityGlyphs(point, 1, 0, '|o');
    expect(glyphs).toHaveLength(2);
    const [tick, circle] = glyphs;
    expect(tick.kind).toBe('tick');
    expect(circle.kind).toBe('circle');
    if (tick.kind !== 'tick' || circle.kind !== 'circle') return;
    const tickDist = Math.hypot((tick.x1 + tick.x2) / 2 - point.x, (tick.y1 + tick.y2) / 2 - point.y);
    const circleDist = Math.hypot(circle.cx - point.x, circle.cy - point.y);
    expect(circleDist).toBeGreaterThan(tickDist);
  });

  it('does not overlap two glyphs of a token: the second glyph starts strictly beyond the first', () => {
    const glyphs: CardinalityGlyph[] = cardinalityGlyphs(point, 1, 0, '|{');
    expect(glyphs).toHaveLength(2);
    const [tick, fork] = glyphs;
    if (tick.kind !== 'tick' || fork.kind !== 'fork') throw new Error('unexpected glyph kinds');
    const tickDist = Math.hypot((tick.x1 + tick.x2) / 2 - point.x, (tick.y1 + tick.y2) / 2 - point.y);
    const forkBaseDist = Math.hypot(fork.prongs[0].x - point.x, fork.prongs[0].y - point.y);
    expect(forkBaseDist).toBeGreaterThan(tickDist);
  });

  it('ignores an unrecognized character (defensive only -- erd.ts already constrains real input)', () => {
    expect(cardinalityGlyphs(point, 1, 0, 'x')).toEqual([]);
  });
});

describe('renderToSvg ER cardinality glyphs replace the generic arrowhead (canvas-2ut)', () => {
  function erModel(edge: Partial<DiagramModel['edges'][number]>): DiagramModel {
    return {
      diagramTypeId: 'erd',
      nodes: [
        { id: 'CUSTOMER', label: 'CUSTOMER', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'ORDER', label: 'ORDER', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'CUSTOMER', targetId: 'ORDER', ...edge }],
      containers: [],
    };
  }

  it('draws a one-to-many (||--o{) relationship with no arrowhead marker and the correct glyph primitives', () => {
    const svg = renderToSvg(erModel({ erSourceCardinality: '||', erTargetCardinality: 'o{' }));

    // No generic arrowhead at all -- standard ERD notation has none.
    expect(svg).not.toMatch(/marker-end/);
    expect(svg).not.toMatch(/marker-start/);

    // Source '||': two perpendicular ticks, no circle/fork. Target 'o{' is read nearest-node-first
    // as written in the DSL ('o' nearest the "--", '{' nearest ORDER) -- reversed to '{o' before
    // being drawn from the ORDER end, giving a fork (3 prong lines) then a circle.
    expect(svg.match(/<circle/g)?.length).toBe(1);
    // 1 main connector <line> + 2 source ticks + 3 target-fork prongs = 6.
    expect(svg.match(/<line/g)?.length).toBe(6);
  });

  it('draws an exactly-one-to-exactly-one (||--||) relationship as four ticks and no circle/fork', () => {
    const svg = renderToSvg(erModel({ erSourceCardinality: '||', erTargetCardinality: '||' }));
    expect(svg).not.toMatch(/marker-end/);
    expect(svg.match(/<circle/g)).toBeNull();
    // 1 main connector line + 2 source ticks + 2 target ticks = 5.
    expect(svg.match(/<line/g)?.length).toBe(5);
  });

  it('applies the dotted (non-identifying) line style alongside the cardinality glyphs, not instead of them', () => {
    const svg = renderToSvg(
      erModel({ erSourceCardinality: '}|', erTargetCardinality: '|{', lineStyle: 'dotted' }),
    );
    // Dashed treatment on the main connector line, exactly like any other dotted edge.
    expect(svg).toMatch(/<line[^>]*stroke-dasharray="[^"]+"/);
    // Still no generic arrowhead.
    expect(svg).not.toMatch(/marker-end/);
    // Source '}|' (fork + tick) and target '|{' reversed to '{|' (fork + tick): 3 + 1 + 3 + 1 = 8
    // glyph lines, plus the 1 main connector line = 9. No circles in either token.
    expect(svg.match(/<circle/g)).toBeNull();
    expect(svg.match(/<line/g)?.length).toBe(9);
  });

  it('renders an edge with NEITHER cardinality field set exactly as before this fix: plain arrowhead, no glyphs', () => {
    const svg = renderToSvg(erModel({}));
    expect(svg).toMatch(/<line[^>]*marker-end="url\(#arrowhead\)"/);
    expect(svg).not.toMatch(/marker-start/);
    expect(svg.match(/<line/g)?.length).toBe(1);
    expect(svg.match(/<circle/g)).toBeNull();
  });

  it('a plain flowchart edge (non-ERD model) is completely unaffected: same plain-arrowhead output as always', () => {
    const svg = renderToSvg({
      diagramTypeId: 'flowchart',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B' }],
      containers: [],
    });
    expect(svg).toMatch(/<line[^>]*marker-end="url\(#arrowhead\)"/);
    expect(svg.match(/<line/g)?.length).toBe(1);
    expect(svg.match(/<circle/g)).toBeNull();
  });
});

describe('umlEndpointGlyph geometry (canvas-7vs.3)', () => {
  const point = { x: 100, y: 100 };

  it('triangle-hollow: a closed 3-point shape, unfilled, tip touching the node', () => {
    const glyph = umlEndpointGlyph(point, 1, 0, 'triangle-hollow');
    expect(glyph.kind).toBe('triangle');
    if (glyph.kind !== 'triangle') return;
    expect(glyph.tip).toEqual(point);
    expect(glyph.filled).toBe(false);
    expect(glyph.baseLeft.x).toBeGreaterThan(point.x);
    expect(glyph.baseLeft.y).not.toBe(glyph.baseRight.y);
  });

  it('diamond-filled vs diamond-hollow differ only in `filled`, not geometry', () => {
    const filled = umlEndpointGlyph(point, 1, 0, 'diamond-filled');
    const hollow = umlEndpointGlyph(point, 1, 0, 'diamond-hollow');
    expect(filled.kind).toBe('diamond');
    expect(hollow.kind).toBe('diamond');
    if (filled.kind !== 'diamond' || hollow.kind !== 'diamond') return;
    expect(filled.filled).toBe(true);
    expect(hollow.filled).toBe(false);
    expect(filled.near).toEqual(hollow.near);
    expect(filled.far).toEqual(hollow.far);
  });

  it('arrow-open: two wing points diverging from the tip, no closing third side (not a closed polygon)', () => {
    const glyph = umlEndpointGlyph(point, 1, 0, 'arrow-open');
    expect(glyph.kind).toBe('open-arrow');
    if (glyph.kind !== 'open-arrow') return;
    expect(glyph.tip).toEqual(point);
    expect(glyph.wingLeft.y).not.toBe(glyph.wingRight.y);
  });

  it('circle: a small hollow circle offset from the node along the direction vector', () => {
    const glyph = umlEndpointGlyph(point, 1, 0, 'circle');
    expect(glyph.kind).toBe('circle');
    if (glyph.kind !== 'circle') return;
    expect(glyph.cx).toBeGreaterThan(point.x);
    expect(glyph.cy).toBe(point.y);
    expect(glyph.r).toBeGreaterThan(0);
  });
});

describe('renderToSvg UML relationship markers replace the generic arrowhead (canvas-7vs.3)', () => {
  function umlModel(edge: Partial<DiagramModel['edges'][number]>): DiagramModel {
    return {
      diagramTypeId: 'uml',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', ...edge }],
      containers: [],
    };
  }

  it('inheritance: a hollow (unfilled) triangle at the SOURCE end, solid line', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'inheritance' }));
    expect(svg).not.toMatch(/marker-end|marker-start/);
    expect(svg).not.toMatch(/stroke-dasharray/);
    const polygon = svg.match(/<polygon points="([^"]+)" fill="([^"]+)"/);
    expect(polygon).not.toBeNull();
    expect(polygon![2]).toBe('white');
    // Tip of the triangle is the first point in the polygon -- must be the SOURCE-side clipped
    // endpoint (x=140, the right edge of A's 140-wide box), not the target side.
    expect(polygon![1].startsWith('140,')).toBe(true);
  });

  it('realization: a hollow triangle at the TARGET end, DASHED line', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'realization' }));
    expect(svg).toMatch(/stroke-dasharray/);
    const polygon = svg.match(/<polygon points="([^"]+)" fill="([^"]+)"/);
    expect(polygon).not.toBeNull();
    expect(polygon![2]).toBe('white');
    // Tip must be the TARGET-side clipped endpoint (x=300, the left edge of B's box).
    expect(polygon![1].startsWith('300,')).toBe(true);
  });

  it('composition: a FILLED diamond at the source end', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'composition' }));
    const polygon = svg.match(/<polygon points="([^"]+)" fill="([^"]+)" stroke="(#333333)"/);
    expect(polygon).not.toBeNull();
    expect(polygon![2]).toBe('#333333'); // filled with the stroke color, not white
  });

  it('aggregation: a hollow diamond at the source end', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'aggregation' }));
    const polygon = svg.match(/<polygon points="([^"]+)" fill="([^"]+)"/);
    expect(polygon![2]).toBe('white');
  });

  it('association: an open arrow (two <line> segments, no <polygon>) at the target end, solid', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'association' }));
    expect(svg).not.toMatch(/<polygon/);
    expect(svg).not.toMatch(/stroke-dasharray/);
    // 1 main connector line + 2 open-arrow wing lines = 3.
    expect(svg.match(/<line/g)?.length).toBe(3);
  });

  it('dependency: an open arrow at the target end, DASHED', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'dependency' }));
    expect(svg).not.toMatch(/<polygon/);
    expect(svg).toMatch(/stroke-dasharray/);
  });

  it('link-solid: a plain line, no marker of any kind', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'link-solid' }));
    expect(svg).not.toMatch(/<polygon|<circle/);
    expect(svg).not.toMatch(/stroke-dasharray/);
    expect(svg.match(/<line/g)?.length).toBe(1);
  });

  it('link-dashed: a plain dashed line, no marker', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'link-dashed' }));
    expect(svg).not.toMatch(/<polygon|<circle/);
    expect(svg).toMatch(/stroke-dasharray/);
  });

  it.each(['lollipop-source', 'lollipop-target'] as const)('%s: a small circle at the named end', (kind) => {
    const svg = renderToSvg(umlModel({ umlRelationKind: kind }));
    expect(svg.match(/<circle/g)?.length).toBe(1);
  });

  it('an edge with no umlRelationKind renders exactly as before this fix: plain arrowhead, no glyphs (no regression)', () => {
    const svg = renderToSvg(umlModel({}));
    expect(svg).toMatch(/<line[^>]*marker-end="url\(#arrowhead\)"/);
    expect(svg).not.toMatch(/<polygon|<circle/);
  });
});

describe('renderToSvg UML relationship cardinality labels (canvas-7vs.5)', () => {
  function umlModel(edge: Partial<DiagramModel['edges'][number]>): DiagramModel {
    return {
      diagramTypeId: 'uml',
      nodes: [
        { id: 'A', label: 'A', shape: 'rectangle', position: { x: 0, y: 0 } },
        { id: 'B', label: 'B', shape: 'rectangle', position: { x: 300, y: 0 } },
      ],
      edges: [{ id: 'e1', sourceId: 'A', targetId: 'B', ...edge }],
      containers: [],
    };
  }

  it('renders sourceCardinality and targetCardinality as separate <text> elements', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'association', sourceCardinality: '1', targetCardinality: '0..*' }));
    expect(svg).toContain('>1<');
    expect(svg).toContain('>0..*<');
  });

  it('renders a cardinality label even with no umlRelationKind set (a plain association can still carry one)', () => {
    const svg = renderToSvg(umlModel({ sourceCardinality: '1' }));
    expect(svg).toContain('>1<');
  });

  it('an edge with neither field renders no stray cardinality text (no regression)', () => {
    const svg = renderToSvg(umlModel({ umlRelationKind: 'association' }));
    expect(svg).not.toMatch(/font-size="11"/);
  });
});

describe('renderToSvg architecture edge anchor hints and {group} escalation (canvas-7vs.6/.7)', () => {
  function archModel(overrides: Partial<DiagramModel> = {}): DiagramModel {
    return {
      diagramTypeId: 'cloud-infrastructure',
      nodes: [
        { id: 'left', label: 'Left', shape: 'rectangle', position: { x: 40, y: 40 } },
        { id: 'right', label: 'Right', shape: 'rectangle', position: { x: 220, y: 40 } },
      ],
      edges: [{ id: 'e1', sourceId: 'left', targetId: 'right' }],
      containers: [],
      ...overrides,
    };
  }

  it('an explicit sourceAnchor/targetAnchor pins each endpoint to that literal side, not the direction-toward-the-other-node default', () => {
    const withoutAnchor = renderToSvg(archModel());
    const withAnchor = renderToSvg(archModel({ edges: [{ id: 'e1', sourceId: 'left', targetId: 'right', sourceAnchor: 'T', targetAnchor: 'T' }] }));
    // Same two nodes, same positions -- only the anchor hint differs, so the line geometry must.
    const lineOf = (svg: string) => svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/)!;
    expect(lineOf(withAnchor)).not.toEqual(lineOf(withoutAnchor));
    // 'T' on a 140x60 node at (40,40): top-center is (110, 40). Node size defaults to 140x60.
    const [, x1, y1] = lineOf(withAnchor);
    expect(Number(x1)).toBeCloseTo(40 + 70);
    expect(Number(y1)).toBeCloseTo(40);
  });

  it('{group} (sourceIsGroup) escalates the clip point to the parent container boundary, not the node\'s own', () => {
    const model = archModel({
      nodes: [
        { id: 'a', label: 'A', shape: 'rectangle', position: { x: 400, y: 40 }, containerId: 'g1' },
        { id: 'right', label: 'Right', shape: 'rectangle', position: { x: 700, y: 40 } },
      ],
      containers: [{ id: 'g1', label: 'Group', position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }],
      edges: [{ id: 'e1', sourceId: 'a', targetId: 'right', sourceIsGroup: true, sourceAnchor: 'R' }],
    });
    const svg = renderToSvg(model);
    const line = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)"/)!;
    // g1 spans x:[40,340], y:[40,240] -- its own right edge is x=340, y=140 (center), NOT node
    // a's own box (which sits at x=400-508, far to the right, entirely outside g1).
    expect(Number(line[1])).toBeCloseTo(340);
    expect(Number(line[2])).toBeCloseTo(140);
  });

  it('an edge with no anchor/group fields renders exactly as before (no regression)', () => {
    const svg = renderToSvg(archModel());
    expect(svg).toContain('<line x1="180" y1="70" x2="220" y2="70"');
  });
});
