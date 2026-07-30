import { describe, expect, it } from 'vitest';
import { renderToSvg } from '../../src/render/svg-renderer.js';
import type { DiagramModel } from '../../src/model/diagram-model.js';

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
