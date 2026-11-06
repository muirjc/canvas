import {
  createEmptyDiagramModel,
  isAllowedLinkHref,
  type DiagramContainer,
  type DiagramNode,
  type FlowchartDirection,
  type MermaidData,
  type NodeLink,
  type NodeShape,
  type NodeStyle,
} from '../model/diagram-model.js';
import { splitFrontMatter, stripTrailingComment, readLegend, readPinned, NO_ENTRIES } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';
import { computeContainmentLayout } from '../model/containment-layout.js';
import { MAX_LINK_LENGTH, MERMAID_NAME, SHAPE_DATA_INNER_SOURCE, SHAPE_DATA_SOURCE, mermaidShapeToCanvas, parseShapeData } from './mermaid-shape-data.js';

const ID = String.raw`[A-Za-z0-9_]+`;

// jmuir-dzd.3: the `:::className` shorthand (jmuir-dzd.2) combined with an inline shape+label
// declaration on the SAME token (`A[Label]:::className`) -- an optional trailing capturing group
// shared by every shape regex below (NODE_PATTERNS) and by BARE_ID's own fallback, so a class name
// is recognized identically regardless of which shape (or no shape at all) a node was declared
// with. The greedy `(.+)` label group in each regex below still backtracks correctly to the
// shape's own closing delimiter first -- a label that itself happens to contain literal `:::`
// text (e.g. `A[foo:::bar]`, no trailing shorthand) is left alone, since the class-suffix group
// only ever matches once a real closing delimiter is found immediately before it.
const CLASS_SUFFIX_CAPTURE = `(?::::(${ID}(?:\\s*,\\s*${ID})*))?`;

// Insertion order is a correctness requirement, not a style preference: each more-specific
// delimiter must be tried before the less-specific pattern it would otherwise collide with
// (see data-model.md's ordering table). `rectangle` must stay last.
const NODE_PATTERNS: Array<{ shape: NodeShape; regex: RegExp }> = [
  { shape: 'subroutine', regex: new RegExp(`^(${ID})\\[\\[(.+)\\]\\]${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'double-circle', regex: new RegExp(`^(${ID})\\(\\(\\((.+)\\)\\)\\)${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'hexagon', regex: new RegExp(`^(${ID})\\{\\{(.+)\\}\\}${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'stadium', regex: new RegExp(`^(${ID})\\(\\[(.+)\\]\\)${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'cylinder', regex: new RegExp(`^(${ID})\\[\\((.+)\\)\\]${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'parallelogram', regex: new RegExp(`^(${ID})\\[/(.+)/\\]${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'parallelogram-alt', regex: new RegExp(`^(${ID})\\[\\\\(.+)\\\\\\]${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'trapezoid', regex: new RegExp(`^(${ID})\\[/(.+)\\\\\\]${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'trapezoid-alt', regex: new RegExp(`^(${ID})\\[\\\\(.+)/\\]${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'asymmetric', regex: new RegExp(`^(${ID})>(.+)\\]${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'circle', regex: new RegExp(`^(${ID})\\(\\((.+)\\)\\)${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'diamond', regex: new RegExp(`^(${ID})\\{(.+)\\}${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'rounded-rectangle', regex: new RegExp(`^(${ID})\\((.+)\\)${CLASS_SUFFIX_CAPTURE}$`) },
  { shape: 'rectangle', regex: new RegExp(`^(${ID})\\[(.+)\\]${CLASS_SUFFIX_CAPTURE}$`) },
];

// A node "token" as it appears at an edge endpoint: a bare id, optionally followed by an inline
// shape+label declaration (Mermaid lets you declare a node's shape the first time it's used as an
// edge endpoint, rather than requiring a separate declaration line).
const SHAPE_SUFFIX = String.raw`\[\[.+?\]\]|\(\(\(.+?\)\)\)|\{\{.+?\}\}|\(\[.+?\]\)|\[\(.+?\)\]|\[/.+?/\]|\[\\.+?\\\]|\[/.+?\\\]|\[\\.+?/\]|>.+?\]|\(\(.+?\)\)|\{.+?\}|\(.+?\)|\[.+?\]`;
// jmuir-dzd.3: the same `:::className` suffix as CLASS_SUFFIX_CAPTURE above, but non-capturing --
// embedded inside TOKEN (itself embedded inside every edge regex below, each of which numbers its
// own source/connector/target capture groups), an extra capturing group here would shift every
// one of those indices.
const CLASS_SUFFIX = String.raw`(?::::${ID}(?:\s*,\s*${ID})*)?`;
// canvas-8wxq: or `A@{ shape: … }` (Mermaid 11.3+), a class going before the block as Mermaid's grammar has it.
const TOKEN = String.raw`${ID}(?:(?:${SHAPE_SUFFIX})?${CLASS_SUFFIX}|${CLASS_SUFFIX}${SHAPE_DATA_SOURCE})`;
// canvas-8wxq: an edge id (`A e1@--> B`), written between the source and the connector; since Mermaid 12.3
// also straight after a shape (`A[x]e1@--> B`). A bare id needs the space (`Ae1@` would be one name).
const EDGE_ID = String.raw`(?:(?:\s+|(?<=[\])}]))(${ID})@|\s*)`;
// `A@{ … }` / `A:::kind@{ … }` as a token or a statement of its own, and `e1@{ … }` for an edge.
const SHAPE_DATA_TOKEN = new RegExp(`^(${ID})(?::::(${ID}(?:\\s*,\\s*${ID})*))?@\\{(${SHAPE_DATA_INNER_SOURCE})\\}$`);

// Grouping B (docs/flowchart-completeness-brief.md), canvas-sfz7: Mermaid's link tokens (its flow lexer's LINK
// rule, less the `x`/`o` ends Canvas doesn't draw) -- a solid, thick, dotted or invisible line with an arrowhead
// at the end, at both ends (`<…>`) or none, made longer by repeating its middle character (`--->`, `====>`,
// `-..->`, `~~~~`), which Mermaid takes as a layout hint. `lineStyle`/`arrow` are left undefined for the
// default (solid line, forward arrowhead), so a plain `A --> B` round-trips as it always has.
type EdgeArrow = 'none' | 'both';
type EdgeLineStyle = 'dotted' | 'thick' | 'invisible';
// The arrowed form of each line before its open one, so `--->` is never read as `---` + `>`.
const CONNECTOR_ALTERNATION = String.raw`<-{2,}>|<={2,}>|<-\.+->|-\.+->|-\.+-|-{2,}>|-{3,}|={2,}>|={3,}|~{3,}`;

/** A link token's line style, arrowheads and Mermaid length (1 for `-->`, plus one per extra `-`, `=` or `.`),
 *  worked out as Mermaid's destructEndLink does. */
function readConnector(token: string): { lineStyle?: EdgeLineStyle; arrow?: EdgeArrow; length: number } {
  const both = token.startsWith('<');
  const line = token.slice(both ? 1 : 0, -1);
  const dots = line.split('.').length - 1;
  const length = Math.min(dots > 0 ? dots : line.length - 1, MAX_LINK_LENGTH);
  const lineStyle = token.startsWith('~') ? 'invisible' : line.includes('=') ? 'thick' : dots > 0 ? 'dotted' : undefined;
  return { lineStyle, arrow: both ? 'both' : token.endsWith('>') ? undefined : 'none', length };
}

const EDGE_WITH_PIPE_LABEL = new RegExp(`^(${TOKEN})${EDGE_ID}(${CONNECTOR_ALTERNATION})\\s*\\|(.+?)\\|\\s*(${TOKEN})$`);
// Inline (embedded) labels: `A -- text --> B` / `A -. text .-> B` / `A == text ==> B`, any length, with or
// without an arrowhead — one regex per line style since the opening and closing halves of the connector must
// match. canvas-sfz7: the opener can't be the start of a longer link (`E --> F ---> G` is a chain, not
// `E --` + a label), and the label can't hold a whole link.
const LABEL_TEXT = String.raw`(?:(?!${CONNECTOR_ALTERNATION}).)+?`;
const EDGE_INLINE_LABEL_SOLID = new RegExp(`^(${TOKEN})${EDGE_ID}--(?![->])\\s*(${LABEL_TEXT})\\s*(-{2,}>|-{3,})\\s*(${TOKEN})$`);
const EDGE_INLINE_LABEL_DOTTED = new RegExp(`^(${TOKEN})${EDGE_ID}-\\.(?![.-])\\s*(${LABEL_TEXT})\\s*(\\.+->|\\.+-)\\s*(${TOKEN})$`);
const EDGE_INLINE_LABEL_THICK = new RegExp(`^(${TOKEN})${EDGE_ID}==(?![=>])\\s*(${LABEL_TEXT})\\s*(={2,}>|={3,})\\s*(${TOKEN})$`);
// Fan-out: `A --> B & C & ...` — one connector, an "&"-separated list of targets.
const EDGE_FAN_OUT = new RegExp(`^(${TOKEN})\\s*(${CONNECTOR_ALTERNATION})\\s*(${TOKEN}(?:\\s*&\\s*${TOKEN})+)$`);
const EDGE_NO_LABEL = new RegExp(`^(${TOKEN})${EDGE_ID}(${CONNECTOR_ALTERNATION})\\s*(${TOKEN})$`);
// Chained edges: `A --> B --> C` — peels one `TOKEN CONNECTOR` hop off the front at a time; each
// hop's connector is independent, so a chain may mix line styles (`A --> B -.-> C`).
const CHAIN_HOP = new RegExp(`^(${TOKEN})${EDGE_ID}(${CONNECTOR_ALTERNATION})\\s*`);
const BARE_TOKEN = new RegExp(`^(${TOKEN})$`);

/** Only a genuine 2+-hop chain is reported; a single hop is just an ordinary edge, already
 *  handled by EDGE_NO_LABEL (and friends) without going through this slower path. */
function tryParseChain(
  line: string,
): { sourceToken: string; edgeId?: string; connectorToken: string; targetToken: string }[] | null {
  const hops: { sourceToken: string; edgeId?: string; connectorToken: string }[] = [];
  let remaining = line;
  let match: RegExpMatchArray | null;
  while ((match = remaining.match(CHAIN_HOP))) {
    hops.push({ sourceToken: match[1], edgeId: match[2], connectorToken: match[3] });
    remaining = remaining.slice(match[0].length);
  }
  if (hops.length < 2) return null;
  const finalMatch = remaining.match(BARE_TOKEN);
  if (!finalMatch) return null;

  const tokens = [...hops.map((h) => h.sourceToken), finalMatch[1]];
  return hops.map((hop, i) => ({ sourceToken: tokens[i], edgeId: hop.edgeId, connectorToken: hop.connectorToken, targetToken: tokens[i + 1] }));
}
const SUBGRAPH_START = new RegExp(`^subgraph\\s+(${ID})(?:\\s*\\[(.+)\\])?$`);
const SUBGRAPH_END = /^end$/;
// Grouping E (docs/flowchart-completeness-brief.md): a `direction` statement is only valid inside
// a subgraph body (real Mermaid grammar, not this platform's own restriction) — matched only when
// `containerStack` is non-empty; a top-level `direction` line falls through to the same
// unrecognized-line error every other out-of-place construct gets.
const SUBGRAPH_DIRECTION = /^direction\s+(TD|LR|TB|RL|BT)$/i;
// jmuir-dzd.3: also accepts a bare id's own trailing `:::className` (e.g. as an edge endpoint --
// `A:::className --> B` -- reached via matchNodeToken's fallback below); a standalone
// `A:::className` declaration line is still caught earlier by CLASS_SHORTHAND (jmuir-dzd.2), so
// this capture is only ever consulted once that line has already been ruled out.
const BARE_ID = new RegExp(`^(${ID})${CLASS_SUFFIX_CAPTURE}$`);
const HEADER = /^(?:flowchart|graph)\s+(TD|LR|TB|RL|BT)$/i;
// canvas-vtg: a real, cross-family Mermaid top-level statement -- mirrors c4.ts's own
// TITLE_PATTERN/handling exactly (canvas-79b introduced it there first).
const TITLE_PATTERN = /^title\s+(.+)$/;
// jmuir-dtu.17: Mermaid's generic accessibility title/description statements -- same
// cross-family, mirror-every-parser precedent as TITLE_PATTERN itself. Single-line colon form
// only; the multi-line `accDescr { ... }` block form is out of scope (a clean parse error, not a
// silent drop).
const ACC_TITLE_PATTERN = /^accTitle\s*:\s*(.+)$/;
const ACC_DESCR_PATTERN = /^accDescr\s*:\s*(.+)$/;
// jmuir-dtu.18: a `%%{init: {...}}%%` (or other `%%{...}%%`) Mermaid config/theme directive.
// Matched BEFORE the generic `%%` comment stripping below (it would otherwise be silently
// swallowed as an ordinary comment, losing its content) -- accepted verbatim, not modeled, same
// treatment as `architectureAlignments`. Real Mermaid places it before the diagram's own header
// line, so this must be checked ahead of the header check too. Single-line only.
const MERMAID_CONFIG_DIRECTIVE_PATTERN = /^%%\{.*\}%%$/;
const STYLE_DIRECTIVE = new RegExp(`^style\\s+(${ID})\\s+(.+)$`);
// Mermaid addresses links by their 0-based declaration order (the Nth edge line encountered),
// not by the platform's internal e1/e2 ids — "default" applies the style to every edge.
const LINK_STYLE_DIRECTIVE = /^linkStyle\s+(default|\d+(?:\s*,\s*\d+)*)\s+(.+)$/;
// Grouping C (docs/flowchart-completeness-brief.md): `classDef <name> <props>` defines a named
// style; `class <id1>,<id2>,... <name>` assigns it to one or more nodes. The trailing `;?` is
// Mermaid's conventional (optional) statement terminator for both forms. Checked before "class"
// below matters only for clarity, not correctness — "classDef" can never match "^class\s+..."
// since the very next character after "class" is "D", not whitespace.
const CLASSDEF_DIRECTIVE = new RegExp(`^classDef\\s+(${ID})\\s+(.+?);?$`);
const CLASS_ASSIGN_DIRECTIVE = new RegExp(`^class\\s+((?:${ID})(?:\\s*,\\s*${ID})*)\\s+(${ID})\\s*;?$`);
// jmuir-dzd.2: the `id:::className` shorthand, equivalent to a separate `class id className`
// line — already supported by erd.ts/uml.ts, missing here. Real Mermaid's own grammar
// (flow.jison: `vertex STYLE_SEPARATOR idString`) only ever accepts a SINGLE class name after
// `:::`, not a comma-separated list; this mirrors erd.ts/uml.ts's own already-shipped, slightly
// more lenient convention of accepting (but only applying the first of) a comma list, for
// consistency across this codebase's three `:::`-supporting parsers rather than introducing a
// fourth, stricter variant.
const CLASS_SHORTHAND = new RegExp(`^(${ID}):::(${ID}(?:\\s*,\\s*${ID})*)$`);
// jmuir-dzd.5, grouping G: `click <id> href "<url>" ["<tooltip>"] [_blank]` -- href/tooltip form
// only, per this feature's own already-decided design (bd show jmuir-dzd's notes). The optional
// trailing `;?` matches classDef/class's own convention above (Mermaid's optional statement
// terminator).
const CLICK_HREF_DIRECTIVE = new RegExp(`^click\\s+(${ID})\\s+href\\s+"([^"]*)"(?:\\s+"([^"]*)")?(?:\\s+(_blank))?\\s*;?$`);
// `click <id> call <fn>(...)` is a SECURITY REJECTION, not a deferral (see isAllowedLinkHref's own
// doc comment for the equivalent href-side reasoning) -- looking up and invoking a global JS
// function by a name written in diagram-author-controlled, pasted-to-import text is a code-
// execution primitive, not a parsing nuance. Matched explicitly so it fails with a clear, named
// error rather than falling through to the generic "could not interpret line" message.
const CLICK_CALL_DIRECTIVE = new RegExp(`^click\\s+(${ID})\\s+call\\s+.*$`);

/** Shared by both `style <nodeId> ...` and `linkStyle <index> ...` — same prop grammar. */
function parseStyleProps(propsRaw: string): NodeStyle {
  const style: NodeStyle = {};
  for (const prop of propsRaw.split(',')) {
    const [key, value] = prop.split(':').map((part) => part.trim());
    if (key === 'fill') style.fillColor = value;
    else if (key === 'stroke') style.strokeColor = value;
    else if (key === 'stroke-width') style.strokeWidth = Number.parseFloat(value);
    else if (key === 'stroke-dasharray') style.strokeDasharray = value;
  }
  return style;
}

/** Parses a single edge-endpoint token into its id and (if inline-declared) shape/label/class, or its
 *  `@{ … }` block (canvas-8wxq). */
function matchNodeToken(
  token: string,
): { id: string; label: string; shape: NodeShape; explicit: boolean; className?: string; data?: string } | null {
  const withData = token.match(SHAPE_DATA_TOKEN);
  if (withData) return { id: withData[1], label: withData[1], shape: 'rectangle', explicit: false, className: withData[2], data: withData[3] };
  for (const { shape, regex } of NODE_PATTERNS) {
    const match = token.match(regex);
    if (match) {
      return { id: match[1], label: match[2], shape, explicit: true, className: match[3] };
    }
  }
  const bare = token.match(BARE_ID);
  if (bare) return { id: bare[1], label: bare[1], shape: 'rectangle', explicit: false, className: bare[2] };
  return null;
}

let autoPositionCounter = 0;

function nextAutoPosition(): { x: number; y: number } {
  const position = { x: (autoPositionCounter % 5) * 180 + 40, y: Math.floor(autoPositionCounter / 5) * 120 + 40 };
  autoPositionCounter += 1;
  return position;
}

/**
 * Parses Mermaid `flowchart` DSL (+ the platform's canvas front-matter) into a DiagramModel.
 * Never throws — unparseable lines are reported as ParseError entries (FR-005/FR-019).
 */
export function parseFlowchart(dsl: string): ParseResult {
  autoPositionCounter = 0;
  const { frontMatter, body } = splitFrontMatter(dsl);
  const canvas = frontMatter.canvas ?? {};
  const positions = canvas.positions ?? NO_ENTRIES;
  const containerMeta = canvas.containers ?? NO_ENTRIES;
  const styles = canvas.styles ?? NO_ENTRIES;
  const edgeStyles = canvas.edgeStyles ?? NO_ENTRIES;
  const icons = canvas.icons ?? NO_ENTRIES;
  // canvas-m0g: see c4.ts's identical comment — a fresh import/paste (no stored geometry at all)
  // gets a real containment-aware auto-layout (nested subgraphs) instead of the flat
  // nextAutoPosition() counter, via a post-pass once the whole tree is known.
  const isFreshImport = Object.keys(positions).length === 0 && Object.keys(containerMeta).length === 0;
  const PLACEHOLDER_POSITION = { x: 0, y: 0 };

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const containersById = new Map<string, DiagramContainer>();
  const edges: {
    id: string;
    sourceId: string;
    targetId: string;
    label?: string;
    style?: NodeStyle;
    arrow?: EdgeArrow;
    lineStyle?: EdgeLineStyle;
    mermaidLength?: number;
    mermaidId?: string;
    mermaidData?: MermaidData;
  }[] = [];
  const edgesByMermaidId = new Map<string, (typeof edges)[number]>();
  // The line being read, for errors found while handling an edge's ends.
  let lineIndex = 0;
  let lineText = '';
  const containerStack: string[] = [];
  const styleDirectives: { nodeId: string; propsRaw: string }[] = [];
  const linkStyleDirectives: { indices: number[] | 'default'; propsRaw: string }[] = [];
  const classDefs = new Map<string, NodeStyle>();
  const classAssignments: { nodeIds: string[]; className: string }[] = [];
  // jmuir-dzd.5: same "conventionally follows the node/edge declarations it targets" deferred-
  // application reasoning as styleDirectives below.
  const linkDirectives: { nodeId: string; link: NodeLink }[] = [];
  let diagramTypeSeen = false;
  let direction: FlowchartDirection | undefined;
  let edgeCounter = 0;
  let title: string | undefined;
  let accTitle: string | undefined;
  let accDescr: string | undefined;
  let mermaidConfigDirective: string | undefined;

  // canvas-ltfa: `explicit` = the token gave a shape and text (`A{Text}`), not a bare id. As in Mermaid, an explicit
  // mention updates a node already seen (`a --> b` then `b{Question?} --> c`): the last definition wins.
  const ensureNode = (id: string, label: string, shape: NodeShape, explicit = false): DiagramNode => {
    let node = nodesById.get(id);
    if (!node) {
      node = {
        id,
        label,
        // canvas-8n7: 'icon' shares rectangle's exact `[label]` bracket delimiters (see
        // flowchart-serializer.ts's SHAPE_DELIMITERS), so a plain `[label]` match is ambiguous
        // between the two — an icon ref in front-matter breaks the tie toward 'icon'. Any other,
        // unambiguous shape (e.g. an explicit cylinder `[(label)]`) is never overridden: a node
        // can validly carry icon metadata without its shape being 'icon'.
        shape: shape === 'rectangle' && icons[id] ? 'icon' : shape,
        position: positions[id] ?? (isFreshImport ? { ...PLACEHOLDER_POSITION } : nextAutoPosition()),
        style: styles[id],
        icon: icons[id],
        containerId: containerStack[containerStack.length - 1],
      };
      nodesById.set(id, node);
    } else {
      node.containerId = node.containerId ?? containerStack[containerStack.length - 1];
      if (explicit) {
        node.label = label;
        node.shape = shape === 'rectangle' && icons[id] ? 'icon' : shape;
      }
    }
    return node;
  };

  // canvas-8wxq: `A@{ shape: …, label: …, … }` -- applied over an existing node too, as Mermaid does.
  const applyShapeData = (node: DiagramNode, inner: string): void => {
    const parsed = parseShapeData(inner);
    let error = 'error' in parsed ? parsed.error : undefined;
    for (const [key, value] of 'entries' in parsed ? parsed.entries : []) {
      if (key === 'shape') {
        if (typeof value !== 'string' || !MERMAID_NAME.test(value)) {
          error = `"${String(value)}" is not a shape name`;
          break;
        }
        node.mermaidShape = value;
        node.shape = mermaidShapeToCanvas(value, !!icons[node.id]);
      } else if (key === 'label') {
        node.label = String(value);
      } else if (key === 'img' && (typeof value !== 'string' || !isAllowedLinkHref(value))) {
        error = '"img" must be an http(s) or relative address';
        break;
      } else {
        node.mermaidData = { ...node.mermaidData, [key]: value };
      }
    }
    if (error) errors.push({ line: lineIndex + 1, content: lineText, message: `In ${node.id}@{ … }: ${error}.` });
  };

  const resolveEdgeEndpoint = (token: string): string => {
    const parsed = matchNodeToken(token);
    if (!parsed) return token;
    const node = ensureNode(parsed.id, parsed.label, parsed.shape, parsed.explicit);
    if (parsed.data !== undefined) applyShapeData(node, parsed.data);
    if (parsed.className) {
      classAssignments.push({ nodeIds: [parsed.id], className: parsed.className.split(',')[0].trim() });
    }
    return parsed.id;
  };

  const pushEdge = (sourceToken: string, connectorToken: string, targetToken: string, label?: string, mermaidId?: string): void => {
    const connector = readConnector(connectorToken);
    edgeCounter += 1;
    const id = `e${edgeCounter}`;
    const edge: (typeof edges)[number] = {
      id,
      sourceId: resolveEdgeEndpoint(sourceToken),
      targetId: resolveEdgeEndpoint(targetToken),
      label,
      style: edgeStyles[id],
      arrow: connector.arrow,
      lineStyle: connector.lineStyle,
    };
    if (connector.length > 1) edge.mermaidLength = connector.length;
    if (mermaidId !== undefined) {
      if (edgesByMermaidId.has(mermaidId)) {
        errors.push({ line: lineIndex + 1, content: lineText, message: `Edge id "${mermaidId}" is used twice.` });
      }
      edge.mermaidId = mermaidId;
      edgesByMermaidId.set(mermaidId, edge);
    }
    edges.push(edge);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    lineIndex = i;
    lineText = rawLine;
    let line = rawLine.trim();
    if (!line) continue;

    if (MERMAID_CONFIG_DIRECTIVE_PATTERN.test(line)) {
      mermaidConfigDirective = line;
      continue;
    }

    line = stripTrailingComment(line);
    if (!line) continue;

    if (!diagramTypeSeen) {
      const headerMatch = line.match(HEADER);
      if (headerMatch) {
        diagramTypeSeen = true;
        direction = headerMatch[1].toUpperCase() as FlowchartDirection;
        continue;
      }
      errors.push({ line: i + 1, content: rawLine, message: 'Expected a "flowchart <direction>" header line' });
      continue;
    }

    const titleMatch = line.match(TITLE_PATTERN);
    if (titleMatch) {
      title = titleMatch[1];
      continue;
    }

    const accTitleMatch = line.match(ACC_TITLE_PATTERN);
    if (accTitleMatch) {
      accTitle = accTitleMatch[1];
      continue;
    }

    const accDescrMatch = line.match(ACC_DESCR_PATTERN);
    if (accDescrMatch) {
      accDescr = accDescrMatch[1];
      continue;
    }

    const subgraphMatch = line.match(SUBGRAPH_START);
    if (subgraphMatch) {
      const [, id, label] = subgraphMatch;
      const meta = containerMeta[id];
      containersById.set(id, {
        id,
        label: label ?? id,
        position: meta ? { x: meta.x, y: meta.y } : (isFreshImport ? { ...PLACEHOLDER_POSITION } : nextAutoPosition()),
        size: meta?.width != null && meta?.height != null ? { width: meta.width, height: meta.height } : undefined,
        parentContainerId: containerStack[containerStack.length - 1],
      });
      containerStack.push(id);
      continue;
    }
    if (SUBGRAPH_END.test(line)) {
      if (containerStack.length === 0) {
        errors.push({ line: i + 1, content: rawLine, message: '"end" with no matching "subgraph"' });
      } else {
        containerStack.pop();
      }
      continue;
    }

    if (containerStack.length > 0) {
      const directionMatch = line.match(SUBGRAPH_DIRECTION);
      if (directionMatch) {
        const currentContainerId = containerStack[containerStack.length - 1];
        const container = containersById.get(currentContainerId)!;
        container.direction = directionMatch[1].toUpperCase() as FlowchartDirection;
        continue;
      }
    }

    const styleMatch = line.match(STYLE_DIRECTIVE);
    if (styleMatch) {
      const [, nodeId, propsRaw] = styleMatch;
      styleDirectives.push({ nodeId, propsRaw });
      continue;
    }

    const linkStyleMatch = line.match(LINK_STYLE_DIRECTIVE);
    if (linkStyleMatch) {
      const [, indexSpec, propsRaw] = linkStyleMatch;
      const indices = indexSpec === 'default' ? 'default' : indexSpec.split(',').map((n) => Number.parseInt(n.trim(), 10));
      linkStyleDirectives.push({ indices, propsRaw });
      continue;
    }

    const classDefMatch = line.match(CLASSDEF_DIRECTIVE);
    if (classDefMatch) {
      const [, className, propsRaw] = classDefMatch;
      classDefs.set(className, parseStyleProps(propsRaw));
      continue;
    }

    const classAssignMatch = line.match(CLASS_ASSIGN_DIRECTIVE);
    if (classAssignMatch) {
      const [, idList, className] = classAssignMatch;
      classAssignments.push({ nodeIds: idList.split(',').map((id) => id.trim()), className });
      continue;
    }

    const classShorthandMatch = line.match(CLASS_SHORTHAND);
    if (classShorthandMatch) {
      const [, id, classNames] = classShorthandMatch;
      ensureNode(id, id, 'rectangle');
      classAssignments.push({ nodeIds: [id], className: classNames.split(',')[0].trim() });
      continue;
    }

    const clickCallMatch = line.match(CLICK_CALL_DIRECTIVE);
    if (clickCallMatch) {
      errors.push({
        line: i + 1,
        content: rawLine,
        message:
          '"click <id> call ..." is not supported: executing a function named by diagram text is a ' +
          'security risk (code execution from untrusted, pasted-to-import content), not a parsing ' +
          'feature. Use "click <id> href \\"<url>\\"" instead.',
      });
      continue;
    }

    const clickHrefMatch = line.match(CLICK_HREF_DIRECTIVE);
    if (clickHrefMatch) {
      const [, nodeId, href, tooltip, target] = clickHrefMatch;
      if (!isAllowedLinkHref(href)) {
        // Cosmetic only (an appsec review, jmuir-dzd.5, confirmed the reject decision itself —
        // isAllowedLinkHref above — is correct regardless of this message's own wording): naming
        // the actual scheme in the error is friendlier than a bare "(unknown)" even when it's
        // obfuscated by a leading space/control character (real Mermaid href text is virtually
        // always clean; this mainly matters for a normal `mailto:`/`tel:` typo, not an attack).
        // Reuses the same URL-parser resolution isAllowedLinkHref itself uses, so this can't
        // report a scheme that check didn't actually see.
        let scheme = '(unknown)';
        try {
          scheme = new URL(href, 'https://relative-path-base.invalid/').protocol.replace(/:$/, '');
        } catch {
          // leave scheme as '(unknown)' -- href isn't a parseable URL at all.
        }
        errors.push({
          line: i + 1,
          content: rawLine,
          message: `click href must use "http://", "https://", or a relative path -- "${scheme}:" is not an allowed scheme.`,
        });
        continue;
      }
      const link: NodeLink = { href };
      if (tooltip !== undefined) link.tooltip = tooltip;
      if (target === '_blank') link.target = '_blank';
      linkDirectives.push({ nodeId, link });
      continue;
    }

    const pipeEdge = line.match(EDGE_WITH_PIPE_LABEL);
    if (pipeEdge) {
      const [, source, edgeId, connector, label, target] = pipeEdge;
      pushEdge(source, connector, target, label, edgeId);
      continue;
    }
    // Chained (`A --> B --> C`) and fan-out (`A --> B & C`) must be tried before the inline-label
    // regexes below: an inline-label regex's lazy label-text group has no way to know a plain
    // multi-hop chain isn't "text" — `A --> B --> C` would otherwise be misread as one edge A->C
    // with the label-open `--` matching the first hop's `-->` and the label swallowing " B ".
    // Neither chain nor fan-out supports a label, so trying them first can't shadow a genuine
    // inline-labeled edge (its `--`/`-.`/`==` open is never itself a complete connector token).
    const chain = tryParseChain(line);
    if (chain) {
      for (const hop of chain) pushEdge(hop.sourceToken, hop.connectorToken, hop.targetToken, undefined, hop.edgeId);
      continue;
    }
    const fanOut = line.match(EDGE_FAN_OUT);
    if (fanOut) {
      const [, source, connector, targetList] = fanOut;
      for (const target of targetList.split('&').map((t) => t.trim())) pushEdge(source, connector, target);
      continue;
    }
    const inlineSolid = line.match(EDGE_INLINE_LABEL_SOLID);
    if (inlineSolid) {
      const [, source, edgeId, label, close, target] = inlineSolid;
      pushEdge(source, close, target, label, edgeId);
      continue;
    }
    const inlineDotted = line.match(EDGE_INLINE_LABEL_DOTTED);
    if (inlineDotted) {
      const [, source, edgeId, label, close, target] = inlineDotted;
      pushEdge(source, `-${close}`, target, label, edgeId);
      continue;
    }
    const inlineThick = line.match(EDGE_INLINE_LABEL_THICK);
    if (inlineThick) {
      const [, source, edgeId, label, close, target] = inlineThick;
      pushEdge(source, close, target, label, edgeId);
      continue;
    }
    const plainEdge = line.match(EDGE_NO_LABEL);
    if (plainEdge) {
      const [, source, edgeId, connector, target] = plainEdge;
      pushEdge(source, connector, target, undefined, edgeId);
      continue;
    }

    // canvas-8wxq: `A@{ … }` on its own line: an edge's options when an edge already has that id (as in
    // Mermaid), else a node's shape data. canvas-lwa4: on a subgraph already closed (Mermaid 11.17,
    // `one@{ view: collapsed }`, `one@{ algorithm: elk.box }`) they are the subgraph's options, kept and written
    // back; Canvas draws the subgraph as usual. Mermaid looks for the subgraph first.
    const shapeData = line.match(SHAPE_DATA_TOKEN);
    if (shapeData) {
      const [, id, classNames, inner] = shapeData;
      const subgraph = classNames === undefined && !containerStack.includes(id) ? containersById.get(id) : undefined;
      const edge = classNames === undefined && !subgraph ? edgesByMermaidId.get(id) : undefined;
      if (subgraph) {
        const parsed = parseShapeData(inner);
        if ('error' in parsed) errors.push({ line: i + 1, content: rawLine, message: `In ${id}@{ … }: ${parsed.error}.` });
        else for (const [key, value] of parsed.entries) subgraph.mermaidData = { ...subgraph.mermaidData, [key]: value };
      } else if (edge) {
        const parsed = parseShapeData(inner);
        if ('error' in parsed) errors.push({ line: i + 1, content: rawLine, message: `In ${id}@{ … }: ${parsed.error}.` });
        else for (const [key, value] of parsed.entries) edge.mermaidData = { ...edge.mermaidData, [key]: value };
      } else if (containersById.has(id)) {
        errors.push({ line: i + 1, content: rawLine, message: `Subgraph options (${id}@{ … }) go after the subgraph's end, without a class.` });
      } else {
        applyShapeData(ensureNode(id, id, 'rectangle'), inner);
        if (classNames) classAssignments.push({ nodeIds: [id], className: classNames.split(',')[0].trim() });
      }
      continue;
    }

    let matchedNode = false;
    for (const { shape, regex } of NODE_PATTERNS) {
      const match = line.match(regex);
      if (match) {
        const [, id, label, className] = match;
        ensureNode(id, label, shape, true);
        if (className) classAssignments.push({ nodeIds: [id], className: className.split(',')[0].trim() });
        matchedNode = true;
        break;
      }
    }
    if (matchedNode) continue;

    const bareId = line.match(BARE_ID);
    if (bareId) {
      ensureNode(bareId[1], bareId[1], 'rectangle');
      continue;
    }

    errors.push({ line: i + 1, content: rawLine, message: `Could not interpret line as a node, edge, or subgraph: "${line}"` });
  }

  // Any edge endpoint not explicitly declared as a node becomes an implicit rectangle node,
  // matching Mermaid's own behavior (FR-003: no element is silently dropped).
  for (const edge of edges) {
    if (!nodesById.has(edge.sourceId)) ensureNode(edge.sourceId, edge.sourceId, 'rectangle');
    if (!nodesById.has(edge.targetId)) ensureNode(edge.targetId, edge.targetId, 'rectangle');
  }

  // Grouping C: resolved as a second pass, same reasoning as `style` below — a `class` line may
  // reference a node only implicitly declared via an edge, or a `classDef` declared later in the
  // file, so both must be fully collected before applying. Runs before `style` below so an
  // explicit `style` directive on the same node can override class-applied properties, matching
  // the intuition that a more specific, node-targeted directive wins over a shared named class.
  for (const { nodeIds, className } of classAssignments) {
    const classStyle = classDefs.get(className);
    for (const nodeId of nodeIds) {
      const node = nodesById.get(nodeId);
      if (!node) continue;
      // canvas-tfr: a node's (first) class IS its standards element kind -- set even when no
      // classDef exists, since a kind needs no Mermaid styling to be meaningful.
      node.role ??= className;
      if (classStyle) node.style = { ...node.style, ...classStyle };
    }
  }

  // Applied as a second pass since `style` lines conventionally follow the node/edge
  // declarations they target (and may reference nodes only implicitly declared via an edge).
  for (const { nodeId, propsRaw } of styleDirectives) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    node.style = { ...node.style, ...parseStyleProps(propsRaw) };
  }

  // jmuir-dzd.5: same deferred-application reasoning as `style` above. A `click` line referencing
  // an id with no matching node (never declared, never an edge endpoint) is silently skipped —
  // real Mermaid's own click directive doesn't itself declare a node, so there's nothing to
  // attach the interaction to, the same "no node created" precedent `style` already established.
  for (const { nodeId, link } of linkDirectives) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    node.link = link;
  }

  // Same idea for `linkStyle`, but edges have no DSL-level id to look up — Mermaid addresses them
  // by 0-based declaration order instead, so this must run after every edge has been collected.
  for (const { indices, propsRaw } of linkStyleDirectives) {
    const targets = indices === 'default' ? edges : indices.map((i) => edges[i]).filter((e): e is (typeof edges)[number] => !!e);
    for (const edge of targets) {
      edge.style = { ...edge.style, ...parseStyleProps(propsRaw) };
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  // canvas-pc76: a node named like a subgraph is that subgraph, as in Mermaid (its group node takes the vertex's
  // place, wherever either appears): links to the id end on the group, and the node's own label, shape and style
  // are dropped. Named inside another subgraph, it puts the group in that one, unless that would make a loop.
  const isWithin = (containerId: string | undefined, ancestorId: string): boolean => {
    const seen = new Set<string>();
    for (let id = containerId; id !== undefined && !seen.has(id); id = containersById.get(id)?.parentContainerId) {
      if (id === ancestorId) return true;
      seen.add(id);
    }
    return false;
  };
  for (const [id, container] of containersById) {
    const node = nodesById.get(id);
    if (!node) continue;
    nodesById.delete(id);
    const parentId = node.containerId;
    if (container.parentContainerId === undefined && parentId !== undefined && containersById.has(parentId) && !isWithin(parentId, id)) {
      container.parentContainerId = parentId;
    }
  }

  // canvas-m0g: see c4.ts's identical post-pass comment.
  if (isFreshImport) {
    const allNodes = Array.from(nodesById.values());
    const allContainers = Array.from(containersById.values());
    const layout = computeContainmentLayout(allNodes, allContainers);
    for (const node of allNodes) node.position = layout.nodePositions.get(node.id) ?? node.position;
    for (const container of allContainers) {
      container.position = layout.containerPositions.get(container.id) ?? container.position;
      container.size = layout.containerSizes.get(container.id);
    }
  }

  const model = createEmptyDiagramModel('flowchart');
  model.direction = direction;
  model.title = title;
  model.accTitle = accTitle;
  model.accDescr = accDescr;
  model.mermaidConfigDirective = mermaidConfigDirective;
  model.nodes = Array.from(nodesById.values());
  model.containers = Array.from(containersById.values());
  model.edges = edges;
  model.legend = readLegend(frontMatter);
  const pinned = readPinned(frontMatter, model);
  if (pinned) model.pinned = pinned;
  return { model };
}
