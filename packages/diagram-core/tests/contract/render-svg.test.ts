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
