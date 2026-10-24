import type { NodeStyle } from '../model/diagram-model.js';
import { detectDslFamily } from './detect.js';
import { parseFlowchart } from './flowchart-parser.js';
import { isParseSuccess } from './types.js';
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

function withStyleLines(dsl: string): string {
  if (detectDslFamily(dsl) !== 'flowchart') return dsl;
  const result = parseFlowchart(dsl);
  if (!isParseSuccess(result)) return dsl;

  const lines: string[] = [];
  for (const node of result.model.nodes) {
    const props = styleProps(node.style);
    if (props) lines.push(`  style ${node.id} ${props}`);
  }
  // linkStyle addresses edges by 0-based declaration order, which is the parser's edge order.
  result.model.edges.forEach((edge, index) => {
    const props = styleProps(edge.style);
    if (props) lines.push(`  linkStyle ${index} ${props}`);
  });
  if (lines.length === 0) return dsl;

  const trimmed = dsl.replace(/\s+$/, '');
  return `${trimmed}\n  %% Colours for other Mermaid tools (added on export; Canvas keeps them in the front matter).\n${lines.join('\n')}\n`;
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
