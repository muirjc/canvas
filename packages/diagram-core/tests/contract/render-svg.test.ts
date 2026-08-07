import { describe, expect, it } from 'vitest';
import { renderToSvg, splitLabelLines, iconNodeSize, nodeSize } from '../../src/render/svg-renderer.js';
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
