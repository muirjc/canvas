import type { DiagramEdge, NodeStyle } from '../model/diagram-model.js';
import { detectDslFamily } from './detect.js';
import { parseFlowchart } from './flowchart-parser.js';
import { parseC4 } from './c4.js';
import { parseErd } from './erd.js';
import { parseUml } from './uml.js';
import { isParseSuccess, type ParseResult } from './types.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { FRONT_MATTER_PATTERN } from './front-matter.js';

/**
 * canvas-jki: a flowchart's colours (hand-picked or a standard kind's swatch) round-trip through
 * the `canvas:` front-matter, which only Canvas reads -- so a downloaded .mmd showed no colours in
 * mermaid.live, GitHub or any other Mermaid tool. This adds plain Mermaid `style <id> ...` and
 * `linkStyle <index> ...` lines carrying the same values, at export time only: the saved DSL (and
 * the DSL panel) are unchanged. Re-importing the file is harmless -- the parser applies those lines
 * on top of the identical front-matter values. Per-node `style`, not one `classDef` per kind,
 * because nodes of one kind can carry different approved swatches. Other families, unparseable
 * input and a flowchart with nothing styled are returned unchanged.
 *
 * canvas-n85n: the same for the other families whose Mermaid grammar has colour syntax, each
 * checked against the Mermaid GitHub renders with (v12.2.0, 2026-10-31):
 *   C4       UpdateElementStyle(id, $bgColor, $borderColor) / UpdateRelStyle(from, to, $lineColor)
 *   ER       style <entity> ...   (no edge colours in Mermaid's ER grammar)
 *   class    style <class> ...    (linkStyle is not class-diagram syntax: it breaks the diagram)
 * Sequence (participants can't be coloured; rect/box colours are already in the DSL) and
 * architecture-beta (no colour syntax) are returned unchanged.
 */
export interface PortableMermaidOptions {
  /**
   * canvas-3s5.1: also drop the `canvas:` front matter (positions, styles, kinds...), keeping only
   * Mermaid's own front-matter keys (title, config). For files people read outside Canvas, e.g.
   * the .mmd in a GitHub pull request; the colours survive as the style lines added above.
   */
  stripFrontMatter?: boolean;
}

export function toPortableMermaid(dsl: string, options: PortableMermaidOptions = {}): string {
  const portable = withStyleLines(dsl);
  return options.stripFrontMatter ? removeCanvasFrontMatter(portable) : portable;
}

/** The front matter minus its `canvas:` key; dropped entirely when nothing else is left. */
function removeCanvasFrontMatter(dsl: string): string {
  const match = dsl.match(FRONT_MATTER_PATTERN);
  if (!match) return dsl;
  const body = dsl.slice(match[0].length);
  const parsed = parseYaml(match[1]) as Record<string, unknown> | null;
  const { canvas: _canvas, ...rest } = parsed ?? {};
  if (Object.keys(rest).length === 0) return body;
  return `---\n${stringifyYaml(rest).trimEnd()}\n---\n${body}`;
}

const COMMENT = '%% Colours for Mermaid tools outside Canvas (added on export).';

function withStyleLines(dsl: string): string {
  const family = detectDslFamily(dsl);
  const lines =
    family === 'flowchart' ? flowchartLines(parseFlowchart(dsl))
    : family === 'c4' ? c4Lines(parseC4(dsl))
    : family === 'erd' ? nodeStyleLines(parseErd(dsl), '')
    : family === 'uml' ? nodeStyleLines(parseUml(dsl), '')
    : [];
  if (lines.length === 0) return dsl;

  // Flowcharts are written indented; the other families' serializers write flush left.
  const indent = family === 'flowchart' ? '  ' : '';
  const trimmed = dsl.replace(/\s+$/, '');
  return `${trimmed}\n${indent}${COMMENT}\n${lines.join('\n')}\n`;
}

function flowchartLines(result: ParseResult): string[] {
  if (!isParseSuccess(result)) return [];
  const lines = nodeStyleLines(result, '  ');
  // linkStyle addresses edges by 0-based declaration order, which is the parser's edge order.
  result.model.edges.forEach((edge, index) => {
    const props = styleProps(edge.style);
    if (props) lines.push(`  linkStyle ${index} ${props}`);
  });
  return lines;
}

/** `style <id> ...` per coloured node: flowchart, ER and class diagrams share this grammar. */
function nodeStyleLines(result: ParseResult, indent: string): string[] {
  if (!isParseSuccess(result)) return [];
  const lines: string[] = [];
  for (const node of result.model.nodes) {
    const props = styleProps(node.style);
    if (props) lines.push(`${indent}style ${node.id} ${props}`);
  }
  return lines;
}

/** C4's own macros carry only colours: no stroke width or dash pattern. */
function c4Lines(result: ParseResult): string[] {
  if (!isParseSuccess(result)) return [];
  const lines: string[] = [];
  for (const node of result.model.nodes) {
    const args = [
      node.style?.fillColor ? `$bgColor="${node.style.fillColor}"` : undefined,
      node.style?.strokeColor ? `$borderColor="${node.style.strokeColor}"` : undefined,
    ].filter(Boolean);
    if (args.length > 0) lines.push(`UpdateElementStyle(${node.id}, ${args.join(', ')})`);
  }
  // Mermaid matches a rel by its endpoints, so UpdateRelStyle colours every rel between a pair.
  // Write it only when they all share one colour; otherwise it would paint the wrong ones (on
  // GitHub, and again when the file is imported back into Canvas).
  const byPair = new Map<string, DiagramEdge[]>();
  for (const edge of result.model.edges) {
    const key = `${edge.sourceId}\u0000${edge.targetId}`;
    byPair.set(key, [...(byPair.get(key) ?? []), edge]);
  }
  for (const [first, ...rest] of byPair.values()) {
    const colour = first.style?.strokeColor;
    if (!colour || rest.some((edge) => edge.style?.strokeColor !== colour)) continue;
    lines.push(`UpdateRelStyle(${first.sourceId}, ${first.targetId}, $lineColor="${colour}")`);
  }
  return lines;
}

function styleProps(style: NodeStyle | undefined): string | undefined {
  if (!style) return undefined;
  const props = [
    style.fillColor ? `fill:${style.fillColor}` : undefined,
    style.strokeColor ? `stroke:${style.strokeColor}` : undefined,
    style.strokeWidth !== undefined ? `stroke-width:${style.strokeWidth}px` : undefined,
    // Commas separate Mermaid style properties, so a "5,5" dasharray is written "5 5".
    style.strokeDasharray ? `stroke-dasharray:${style.strokeDasharray.replace(/,/g, ' ')}` : undefined,
  ].filter((prop): prop is string => prop !== undefined);
  return props.length > 0 ? props.join(',') : undefined;
}
