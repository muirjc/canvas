import type { DiagramContainer, DiagramEdge, DiagramModel, NodeStyle } from '../model/diagram-model.js';
import { containerSize, nodeSize } from '../render/svg-renderer.js';
import { parseArchitecture, serializeArchitecture } from './architecture.js';
import { detectDslFamily } from './detect.js';
import { parseFlowchart } from './flowchart-parser.js';
import { serializeFlowchart } from './flowchart-serializer.js';
import { parseC4, serializeC4 } from './c4.js';
import { DEFAULT_RELATIONSHIP_LABEL, parseErd, serializeErd } from './erd.js';
import { parseUml, serializeUml } from './uml.js';
import { parseSequence, serializeSequence } from './sequence.js';
import { parseState, serializeState } from './state.js';
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
  // The family is read once, from the text as saved, and used for both steps.
  const family = detectDslFamily(dsl);
  const rewritten = withMermaidForms(dsl, family);
  const portable = withStyleLines(rewritten === dsl ? dsl : withOriginalKeys(dsl, rewritten), family);
  return options.stripFrontMatter ? removeCanvasFrontMatter(portable) : portable;
}

/**
 * canvas-0t84, canvas-8ucs: Canvas reads (and writes back) some text real Mermaid refuses. The export always writes
 * the diagram again in Canvas's own form (decided with the user: anything Canvas opens then draws in Mermaid; the
 * typed text's comments and spacing are left out of the file), adjusting what Mermaid refuses per family below. The
 * saved diagram is unchanged. Text Canvas can't read is exported as it is.
 */
function withMermaidForms(dsl: string, family: ReturnType<typeof detectDslFamily>): string {
  switch (family) {
    case 'architecture':
      return architectureForms(dsl);
    case 'c4':
      return c4Forms(dsl);
    case 'erd':
      return erdForms(dsl);
    case 'uml':
      return umlForms(dsl);
    case 'sequence':
      return sequenceForms(dsl);
    case 'flowchart':
      return flowchartForms(dsl);
    case 'state': {
      const result = parseState(dsl);
      return isParseSuccess(result) ? serializeState(withoutNulls(result.model)) : dsl;
    }
    default:
      return dsl;
  }
}

/** A model with its `null` fields left out, before it is written again: a `null` typed into the front matter (a
 *  style's `strokeWidth: null`) means nothing set, and the server's copy can't tell it from a field never set. */
function withoutNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutNulls) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]),
    ) as T;
  }
  return value;
}

/** Groups Mermaid can't draw empty (a C4 boundary, a class namespace), left out -- and then any group they leave
 *  empty, and so on up. `isGroup` picks which containers count. */
function withoutEmptyGroups(model: DiagramModel, isGroup: (c: DiagramContainer) => boolean): DiagramContainer[] {
  let containers = model.containers;
  for (;;) {
    const kept = containers.filter(
      (c) =>
        !isGroup(c) ||
        model.nodes.some((n) => n.containerId === c.id) ||
        containers.some((child) => child.parentContainerId === c.id),
    );
    if (kept.length === containers.length) return containers;
    containers = kept;
  }
}

/** C4: `Lay_*` hints are C4-PlantUML's (Mermaid's lexer refuses them); an empty boundary doesn't parse. */
function c4Forms(dsl: string): string {
  const result = parseC4(dsl);
  if (!isParseSuccess(result)) return dsl;
  const { model } = result;
  const containers = withoutEmptyGroups(model, () => true);
  const { layoutHints: _hints, ...rest } = model;
  return serializeC4(withoutNulls({ ...rest, containers }));
}

/** Text Mermaid reads inside double quotes, its own `"` written as the `#quot;` entity. */
const quoted = (text: string): string => `"${text.replace(/"/g, '#quot;')}"`;

/** ER: relationship labels and aliases are quoted. A bare one must be a single word that isn't one of Mermaid's
 *  ER keywords (`many`, `one`, `to`, `class`, a number, ...), so quoting them all is the safe form. */
function erdForms(dsl: string): string {
  const result = parseErd(dsl);
  if (!isParseSuccess(result)) return dsl;
  const { model } = result;
  const nodes = model.nodes.map((node) => (node.label === node.id ? node : { ...node, label: quoted(node.label) }));
  const edges = model.edges.map((edge) => ({ ...edge, label: quoted(edge.label?.trim() || DEFAULT_RELATIONSHIP_LABEL) }));
  return serializeErd(withoutNulls({ ...model, nodes, edges }));
}

/** Class diagrams: a `:` in a relationship label ends it early (written as `#58;`); an empty namespace or an
 *  empty note doesn't parse. */
function umlForms(dsl: string): string {
  const result = parseUml(dsl);
  if (!isParseSuccess(result)) return dsl;
  const { model } = result;
  const edges = model.edges.map((edge) => (edge.label?.includes(':') ? { ...edge, label: edge.label.replace(/:/g, '#58;') } : edge));
  const withNotes = model.containers.filter((c) => c.role !== 'note' || c.label.trim() !== '');
  const containers = withoutEmptyGroups({ ...model, containers: withNotes }, (c) => c.role === 'namespace');
  return serializeUml(withoutNulls({ ...model, edges, containers }));
}

/** Sequence: a note goes over one participant or spans two; a note over more spans the first to the last. */
function sequenceForms(dsl: string): string {
  const result = parseSequence(dsl);
  if (!isParseSuccess(result)) return dsl;
  const { model } = result;
  const order = new Map(model.nodes.map((node, index) => [node.id, index]));
  const containers = model.containers.map((container) => {
    const ids = container.attachedNodeIds ?? [];
    if (container.role !== 'note-over' || ids.length <= 2) return container;
    const sorted = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return { ...container, attachedNodeIds: [sorted[0], sorted[sorted.length - 1]] };
  });
  return serializeSequence(withoutNulls({ ...model, containers }));
}

/** Flowchart: Mermaid takes a flowchart's title from the front matter only, and a `"` inside a quoted label ends
 *  it (written as `#quot;`). */
function flowchartForms(dsl: string): string {
  const result = parseFlowchart(dsl);
  if (!isParseSuccess(result)) return dsl;
  const { model } = result;
  const nodes = model.nodes.map((node) => (node.label?.includes('"') ? { ...node, label: node.label.replace(/"/g, '#quot;') } : node));
  const text = serializeFlowchart(withoutNulls({ ...model, nodes, title: undefined }));
  return model.title ? withFrontMatterTitle(text, model.title) : text;
}

/** The rewritten text with the original front matter's own Mermaid keys (`title`, `config`, ...) put back first: the
 *  serializers write only `canvas:` (and a state diagram's or a moved flowchart's title, which wins). */
function withOriginalKeys(original: string, rewritten: string): string {
  const keys = frontMatterKeys(original);
  delete keys.canvas;
  if (Object.keys(keys).length === 0) return rewritten;
  const match = rewritten.match(FRONT_MATTER_PATTERN);
  const body = match ? rewritten.slice(match[0].length) : rewritten;
  const merged = { ...keys, ...(match ? frontMatterKeys(rewritten) : {}) };
  return `---\n${stringifyYaml(merged).trimEnd()}\n---\n${body}`;
}

/** A text's front matter as an object of its keys (none when it has no front matter or it isn't a mapping). */
function frontMatterKeys(text: string): Record<string, unknown> {
  const match = text.match(FRONT_MATTER_PATTERN);
  const parsed: unknown = match ? parseYaml(match[1]) : undefined;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
}

/** The text with `title:` first in its front matter (made if there is none). */
function withFrontMatterTitle(text: string, title: string): string {
  const match = text.match(FRONT_MATTER_PATTERN);
  const parsed: unknown = match ? parseYaml(match[1]) : undefined;
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const { title: _old, ...rest } = keys;
  const body = match ? text.slice(match[0].length) : text;
  return `---\n${stringifyYaml({ title, ...rest }).trimEnd()}\n---\n${body}`;
}

function architectureForms(dsl: string): string {
  const result = parseArchitecture(dsl);
  if (!isParseSuccess(result)) return dsl;
  const { model } = result;
  // Typed text can also name a service that doesn't exist (a connector to it, an align row with it); Mermaid
  // refuses the whole diagram, so the export leaves those out.
  const ids = new Set(model.nodes.map((n) => n.id));
  // Mermaid also names a connector after its ends (`a-b`) and refuses a second one with the same name, so only
  // the first connector each way between two services is kept.
  const names = new Set<string>();
  const edges = model.edges.filter((edge) => {
    const name = `${edge.sourceId}-${edge.targetId}`;
    if (!ids.has(edge.sourceId) || !ids.has(edge.targetId) || names.has(name)) return false;
    names.add(name);
    return true;
  });
  const alignments = (model.architectureAlignments ?? [])
    .map((alignment) => ({ ...alignment, ids: alignment.ids.filter((id) => ids.has(id)) }))
    .filter((alignment) => alignment.ids.length >= 2);
  return serializeArchitecture(
    withoutNulls({
      ...model,
      edges: edges.map((edge) => withSides(model, edge)),
      ...(model.architectureAlignments ? { architectureAlignments: alignments } : {}),
    }),
  );
}

type Side = 'T' | 'B' | 'L' | 'R';
const OPPOSITE: Record<Side, Side> = { T: 'B', B: 'T', L: 'R', R: 'L' };

/** The middle of a connector's end as Canvas draws it: the service, or its group for a `{group}` end. */
function endCenter(model: DiagramModel, id: string, isGroup: boolean | undefined): { x: number; y: number } | undefined {
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return undefined;
  const group = isGroup && node.containerId ? model.containers.find((c) => c.id === node.containerId) : undefined;
  if (group) {
    const size = containerSize(group);
    return { x: group.position.x + size.width / 2, y: group.position.y + size.height / 2 };
  }
  const size = nodeSize(node);
  return { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
}

function withSides(model: DiagramModel, edge: DiagramEdge): DiagramEdge {
  if (edge.sourceAnchor && edge.targetAnchor) return edge;
  const from = endCenter(model, edge.sourceId, edge.sourceIsGroup);
  const to = endCenter(model, edge.targetId, edge.targetIsGroup);
  if (!from || !to) return edge;
  let source: Side;
  let target: Side;
  if (edge.sourceId === edge.targetId && !edge.sourceIsGroup === !edge.targetIsGroup) {
    // A loop: out of the right, back in at the top.
    [source, target] = ['R', 'T'];
  } else {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    source = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'R' : 'L') : dy >= 0 ? 'B' : 'T';
    target = OPPOSITE[source];
  }
  return { ...edge, sourceAnchor: edge.sourceAnchor || source, targetAnchor: edge.targetAnchor || target };
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

function withStyleLines(dsl: string, family: ReturnType<typeof detectDslFamily>): string {
  const lines =
    family === 'flowchart' ? flowchartLines(parseFlowchart(dsl))
    : family === 'c4' ? c4Lines(parseC4(dsl))
    : family === 'erd' ? nodeStyleLines(parseErd(dsl), '')
    : family === 'uml' ? nodeStyleLines(parseUml(dsl), '')
    : family === 'state' ? stateLines(parseState(dsl))
    : [];
  if (lines.length === 0) return dsl;

  // Flowcharts are written indented; the other families' serializers write flush left.
  const indent = family === 'flowchart' || family === 'state' ? '  ' : '';
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

/** canvas-bnnh: state diagrams colour states through classes (Mermaid's documented form): one classDef per
 *  distinct colouring, assigned to its states. Start/end points and composite states are left alone, as
 *  Mermaid's docs say classes don't apply to them. */
function stateLines(result: ParseResult): string[] {
  if (!isParseSuccess(result)) return [];
  const classOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const node of result.model.nodes) {
    if (node.role === 'start' || node.role === 'end') continue;
    const props = styleProps(node.style);
    if (!props) continue;
    if (!classOf.has(props)) classOf.set(props, `canvasStyle${classOf.size + 1}`);
    const name = classOf.get(props)!;
    members.set(name, [...(members.get(name) ?? []), node.id]);
  }
  return [...classOf].flatMap(([props, name]) => [`  classDef ${name} ${props}`, `  class ${members.get(name)!.join(',')} ${name}`]);
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
    // A `strokeWidth: null` typed into the front matter is no width (it was written `nullpx`).
    style.strokeWidth != null ? `stroke-width:${style.strokeWidth}px` : undefined,
    // Commas separate Mermaid style properties, so a "5,5" dasharray is written "5 5".
    style.strokeDasharray ? `stroke-dasharray:${style.strokeDasharray.replace(/,/g, ' ')}` : undefined,
  ].filter((prop): prop is string => prop !== undefined);
  return props.length > 0 ? props.join(',') : undefined;
}
