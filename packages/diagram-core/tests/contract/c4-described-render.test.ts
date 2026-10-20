import { describe, expect, it } from 'vitest';
import { parseC4 } from '../../src/dsl/c4.js';
import { isParseSuccess } from '../../src/dsl/types.js';
import type { DiagramModel, DiagramNode } from '../../src/model/diagram-model.js';
import { clampPersonHeadRadius, describedNodeLayout, edgeTechnologyLayout, nodeSize, plainNodeSize, renderToSvg } from '../../src/render/svg-renderer.js';

/**
 * canvas-8th: C4 descriptions and technology strings survive save (canvas-1u2) but neither
 * renderer drew them -- the diagram showed only each element's name. Mermaid draws the technology
 * in brackets under the name and the description below it, and a relationship's technology under
 * its label. One shared layout (describedNodeLayout / edgeTechnologyLayout) keeps the canvas and
 * the export identical.
 */

function parseOk(dsl: string): DiagramModel {
  const result = parseC4(dsl);
  expect(isParseSuccess(result)).toBe(true);
  if (!isParseSuccess(result)) throw new Error('unreachable');
  return result.model;
}

const DSL = [
  'C4Container',
  'Person(customer, "Customer", "A bank customer with personal accounts")',
  'Container(api, "API Application", "Java, Spring MVC", "Provides all of the internet banking functionality to customers via a JSON/HTTPS API")',
  'System(plain, "Plain System")',
  'Rel(customer, api, "Uses", "HTTPS")',
  'Rel(api, plain, "Reads from")',
  '',
].join('\n');

const node = (model: DiagramModel, id: string): DiagramNode => model.nodes.find((n) => n.id === id)!;

describe('canvas-8th: described C4 elements', () => {
  const model = parseOk(DSL);

  it('lays out the name, the bracketed technology and the wrapped description, inside the box', () => {
    const api = node(model, 'api');
    const layout = describedNodeLayout(api)!;
    expect(layout).not.toBeNull();
    const texts = layout.lines.map((l) => l.text);
    expect(texts[0]).toBe('API Application');
    expect(layout.lines[0].bold).toBe(true);
    expect(texts).toContain('[Java, Spring MVC]');
    // The long description wraps onto several lines, in order.
    const descLines = texts.slice(texts.indexOf('[Java, Spring MVC]') + 1);
    expect(descLines.length).toBeGreaterThan(1);
    expect(descLines.join(' ')).toBe('Provides all of the internet banking functionality to customers via a JSON/HTTPS API');

    const size = nodeSize(api);
    for (const line of layout.lines) {
      expect(line.x).toBeCloseTo(api.position.x + size.width / 2);
      expect(line.y).toBeGreaterThan(api.position.y);
      expect(line.y).toBeLessThan(api.position.y + size.height);
    }
    // Lines are stacked top to bottom.
    for (let i = 1; i < layout.lines.length; i += 1) expect(layout.lines[i].y).toBeGreaterThan(layout.lines[i - 1].y);
  });

  it('a described element gets a wider box that grows to fit; a plain one keeps the default size', () => {
    expect(plainNodeSize(node(model, 'api')).width).toBe(200);
    expect(plainNodeSize(node(model, 'api')).height).toBeGreaterThan(60);
    expect(plainNodeSize(node(model, 'plain'))).toEqual({ width: 140, height: 60 });
    expect(describedNodeLayout(node(model, 'plain'))).toBeNull();
  });

  it('a description alone (no technology) is drawn without an empty bracket line', () => {
    const texts = describedNodeLayout(node(model, 'customer'))!.lines.map((l) => l.text);
    expect(texts[0]).toBe('Customer');
    expect(texts.some((t) => t.startsWith('['))).toBe(false);
    expect(texts.slice(1).join(' ')).toBe('A bank customer with personal accounts');
  });

  it("a Person's lines sit in its body, below the head -- never behind it", () => {
    const customer = node(model, 'customer');
    const size = nodeSize(customer);
    const headBottom = customer.position.y + 4 + 2 * clampPersonHeadRadius(size.width, size.height);
    for (const line of describedNodeLayout(customer)!.lines) {
      expect(line.y - line.fontSize / 2).toBeGreaterThan(headBottom);
      expect(line.y).toBeLessThan(customer.position.y + size.height);
    }
  });

  it('the SVG export draws every laid-out line', () => {
    const svg = renderToSvg(model);
    for (const line of describedNodeLayout(node(model, 'api'))!.lines) {
      expect(svg).toContain(`>${line.text.replace(/&/g, '&amp;')}</text>`);
    }
  });

  it('an explicit node size is respected (the layout fits inside it)', () => {
    const api = { ...node(model, 'api'), size: { width: 260, height: 180 } };
    const layout = describedNodeLayout(api)!;
    for (const line of layout.lines) expect(line.x).toBeCloseTo(api.position.x + 130);
  });
});

describe('canvas-8th: relationship technology', () => {
  const model = parseOk(DSL);

  it('lays out a Rel technology under its label, and the export draws it', () => {
    const uses = model.edges.find((e) => e.label === 'Uses')!;
    const layout = edgeTechnologyLayout(uses, 100, 50)!;
    expect(layout.text).toBe('[HTTPS]');
    expect(layout.y).toBeGreaterThan(50);
    expect(renderToSvg(model)).toContain('>[HTTPS]</text>');
  });

  it('a Rel without technology has none', () => {
    expect(edgeTechnologyLayout(model.edges.find((e) => e.label === 'Reads from')!, 100, 50)).toBeNull();
  });
});
