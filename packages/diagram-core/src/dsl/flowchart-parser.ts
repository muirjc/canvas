import {
  createEmptyDiagramModel,
  type DiagramContainer,
  type DiagramNode,
  type FlowchartDirection,
  type NodeShape,
  type NodeStyle,
} from '../model/diagram-model.js';
import { splitFrontMatter } from './front-matter.js';
import type { ParseError, ParseResult } from './types.js';
import { computeContainmentLayout } from '../model/containment-layout.js';

const ID = String.raw`[A-Za-z0-9_]+`;

// Insertion order is a correctness requirement, not a style preference: each more-specific
// delimiter must be tried before the less-specific pattern it would otherwise collide with
// (see data-model.md's ordering table). `rectangle` must stay last.
const NODE_PATTERNS: Array<{ shape: NodeShape; regex: RegExp }> = [
  { shape: 'subroutine', regex: new RegExp(`^(${ID})\\[\\[(.+)\\]\\]$`) },
  { shape: 'double-circle', regex: new RegExp(`^(${ID})\\(\\(\\((.+)\\)\\)\\)$`) },
  { shape: 'hexagon', regex: new RegExp(`^(${ID})\\{\\{(.+)\\}\\}$`) },
  { shape: 'stadium', regex: new RegExp(`^(${ID})\\(\\[(.+)\\]\\)$`) },
  { shape: 'cylinder', regex: new RegExp(`^(${ID})\\[\\((.+)\\)\\]$`) },
  { shape: 'parallelogram', regex: new RegExp(`^(${ID})\\[/(.+)/\\]$`) },
  { shape: 'parallelogram-alt', regex: new RegExp(`^(${ID})\\[\\\\(.+)\\\\\\]$`) },
  { shape: 'trapezoid', regex: new RegExp(`^(${ID})\\[/(.+)\\\\\\]$`) },
  { shape: 'trapezoid-alt', regex: new RegExp(`^(${ID})\\[\\\\(.+)/\\]$`) },
  { shape: 'asymmetric', regex: new RegExp(`^(${ID})>(.+)\\]$`) },
  { shape: 'circle', regex: new RegExp(`^(${ID})\\(\\((.+)\\)\\)$`) },
  { shape: 'diamond', regex: new RegExp(`^(${ID})\\{(.+)\\}$`) },
  { shape: 'rounded-rectangle', regex: new RegExp(`^(${ID})\\((.+)\\)$`) },
  { shape: 'rectangle', regex: new RegExp(`^(${ID})\\[(.+)\\]$`) },
];

// A node "token" as it appears at an edge endpoint: a bare id, optionally followed by an inline
// shape+label declaration (Mermaid lets you declare a node's shape the first time it's used as an
// edge endpoint, rather than requiring a separate declaration line).
const SHAPE_SUFFIX = String.raw`\[\[.+?\]\]|\(\(\(.+?\)\)\)|\{\{.+?\}\}|\(\[.+?\]\)|\[\(.+?\)\]|\[/.+?/\]|\[\\.+?\\\]|\[/.+?\\\]|\[\\.+?/\]|>.+?\]|\(\(.+?\)\)|\{.+?\}|\(.+?\)|\[.+?\]`;
const TOKEN = String.raw`${ID}(?:${SHAPE_SUFFIX})?`;

// Grouping B (docs/flowchart-completeness-brief.md): the ten flowchart connector tokens, each
// naming a (lineStyle, arrow) pair. `lineStyle`/`arrow` are left undefined on the parsed edge for
// the default case (solid line, forward arrowhead) rather than filled in explicitly, so a plain
// `A --> B` keeps round-tripping identically to how it always has.
// 'target' (a plain forward arrowhead) is the default and so is never actually assigned here —
// it's represented by leaving `arrow` undefined, not by a literal 'target' value.
type EdgeArrow = 'none' | 'both';
type EdgeLineStyle = 'dotted' | 'thick' | 'invisible';
const EDGE_CONNECTORS: { token: string; lineStyle?: EdgeLineStyle; arrow?: EdgeArrow }[] = [
  { token: '<-.->', lineStyle: 'dotted', arrow: 'both' },
  { token: '<-->', arrow: 'both' },
  { token: '<==>', lineStyle: 'thick', arrow: 'both' },
  { token: '-.->', lineStyle: 'dotted' },
  { token: '==>', lineStyle: 'thick' },
  { token: '-->' },
  { token: '-.-', lineStyle: 'dotted', arrow: 'none' },
  { token: '===', lineStyle: 'thick', arrow: 'none' },
  { token: '---', arrow: 'none' },
  { token: '~~~', lineStyle: 'invisible', arrow: 'none' },
];
const CONNECTOR_BY_TOKEN = new Map(EDGE_CONNECTORS.map((c) => [c.token, c]));
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Every token here is a full, fixed literal (no two share a starting substring that would make
// one shadow the other), so alternation order doesn't affect correctness — listed roughly
// longest-first anyway as the clearer convention to read.
const CONNECTOR_ALTERNATION = EDGE_CONNECTORS.map((c) => escapeRegex(c.token)).join('|');

const EDGE_WITH_PIPE_LABEL = new RegExp(`^(${TOKEN})\\s*(${CONNECTOR_ALTERNATION})\\s*\\|(.+?)\\|\\s*(${TOKEN})$`);
// Inline (embedded) labels: `A -- text --> B` / `A -. text .-> B` / `A == text ==> B` — one
// regex per line style since the opening and closing halves of the connector must match (a
// single alternation of independent opens/closes could not enforce that pairing).
const EDGE_INLINE_LABEL_SOLID = new RegExp(`^(${TOKEN})\\s*--\\s*(.+?)\\s*-->\\s*(${TOKEN})$`);
const EDGE_INLINE_LABEL_DOTTED = new RegExp(`^(${TOKEN})\\s*-\\.\\s*(.+?)\\s*\\.->\\s*(${TOKEN})$`);
const EDGE_INLINE_LABEL_THICK = new RegExp(`^(${TOKEN})\\s*==\\s*(.+?)\\s*==>\\s*(${TOKEN})$`);
// Fan-out: `A --> B & C & ...` — one connector, an "&"-separated list of targets.
const EDGE_FAN_OUT = new RegExp(`^(${TOKEN})\\s*(${CONNECTOR_ALTERNATION})\\s*(${TOKEN}(?:\\s*&\\s*${TOKEN})+)$`);
const EDGE_NO_LABEL = new RegExp(`^(${TOKEN})\\s*(${CONNECTOR_ALTERNATION})\\s*(${TOKEN})$`);
// Chained edges: `A --> B --> C` — peels one `TOKEN CONNECTOR` hop off the front at a time; each
// hop's connector is independent, so a chain may mix line styles (`A --> B -.-> C`).
const CHAIN_HOP = new RegExp(`^(${TOKEN})\\s*(${CONNECTOR_ALTERNATION})\\s*`);
const BARE_TOKEN = new RegExp(`^(${TOKEN})$`);

/** Only a genuine 2+-hop chain is reported; a single hop is just an ordinary edge, already
 *  handled by EDGE_NO_LABEL (and friends) without going through this slower path. */
function tryParseChain(line: string): { sourceToken: string; connectorToken: string; targetToken: string }[] | null {
  const hops: { sourceToken: string; connectorToken: string }[] = [];
  let remaining = line;
  let match: RegExpMatchArray | null;
  while ((match = remaining.match(CHAIN_HOP))) {
    hops.push({ sourceToken: match[1], connectorToken: match[2] });
    remaining = remaining.slice(match[0].length);
  }
  if (hops.length < 2) return null;
  const finalMatch = remaining.match(BARE_TOKEN);
  if (!finalMatch) return null;

  const tokens = [...hops.map((h) => h.sourceToken), finalMatch[1]];
  return hops.map((hop, i) => ({ sourceToken: tokens[i], connectorToken: hop.connectorToken, targetToken: tokens[i + 1] }));
}
const SUBGRAPH_START = new RegExp(`^subgraph\\s+(${ID})(?:\\s*\\[(.+)\\])?$`);
const SUBGRAPH_END = /^end$/;
// Grouping E (docs/flowchart-completeness-brief.md): a `direction` statement is only valid inside
// a subgraph body (real Mermaid grammar, not this platform's own restriction) — matched only when
// `containerStack` is non-empty; a top-level `direction` line falls through to the same
// unrecognized-line error every other out-of-place construct gets.
const SUBGRAPH_DIRECTION = /^direction\s+(TD|LR|TB|RL|BT)$/i;
const BARE_ID = new RegExp(`^(${ID})$`);
const HEADER = /^(?:flowchart|graph)\s+(TD|LR|TB|RL|BT)$/i;
// canvas-vtg: a real, cross-family Mermaid top-level statement -- mirrors c4.ts's own
// TITLE_PATTERN/handling exactly (canvas-79b introduced it there first).
const TITLE_PATTERN = /^title\s+(.+)$/;
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

/** Parses a single edge-endpoint token into its id and (if inline-declared) shape/label. */
function matchNodeToken(token: string): { id: string; label: string; shape: NodeShape } | null {
  for (const { shape, regex } of NODE_PATTERNS) {
    const match = token.match(regex);
    if (match) {
      return { id: match[1], label: match[2], shape };
    }
  }
  const bare = token.match(BARE_ID);
  if (bare) return { id: bare[1], label: bare[1], shape: 'rectangle' };
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
  const positions = canvas.positions ?? {};
  const containerMeta = canvas.containers ?? {};
  const styles = canvas.styles ?? {};
  const edgeStyles = canvas.edgeStyles ?? {};
  const icons = canvas.icons ?? {};
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
  }[] = [];
  const containerStack: string[] = [];
  const styleDirectives: { nodeId: string; propsRaw: string }[] = [];
  const linkStyleDirectives: { indices: number[] | 'default'; propsRaw: string }[] = [];
  const classDefs = new Map<string, NodeStyle>();
  const classAssignments: { nodeIds: string[]; className: string }[] = [];
  let diagramTypeSeen = false;
  let direction: FlowchartDirection | undefined;
  let edgeCounter = 0;
  let title: string | undefined;

  const ensureNode = (id: string, label: string, shape: NodeShape): DiagramNode => {
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
        position: positions[id] ?? (isFreshImport ? PLACEHOLDER_POSITION : nextAutoPosition()),
        style: styles[id],
        icon: icons[id],
        containerId: containerStack[containerStack.length - 1],
      };
      nodesById.set(id, node);
    } else {
      node.containerId = node.containerId ?? containerStack[containerStack.length - 1];
    }
    return node;
  };

  const resolveEdgeEndpoint = (token: string): string => {
    const parsed = matchNodeToken(token);
    if (!parsed) return token;
    ensureNode(parsed.id, parsed.label, parsed.shape);
    return parsed.id;
  };

  const pushEdge = (sourceToken: string, connectorToken: string, targetToken: string, label?: string): void => {
    const connector = CONNECTOR_BY_TOKEN.get(connectorToken)!;
    edgeCounter += 1;
    const id = `e${edgeCounter}`;
    edges.push({
      id,
      sourceId: resolveEdgeEndpoint(sourceToken),
      targetId: resolveEdgeEndpoint(targetToken),
      label,
      style: edgeStyles[id],
      arrow: connector.arrow,
      lineStyle: connector.lineStyle,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%%')) continue;

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

    const subgraphMatch = line.match(SUBGRAPH_START);
    if (subgraphMatch) {
      const [, id, label] = subgraphMatch;
      const meta = containerMeta[id];
      containersById.set(id, {
        id,
        label: label ?? id,
        position: meta ? { x: meta.x, y: meta.y } : (isFreshImport ? PLACEHOLDER_POSITION : nextAutoPosition()),
        size: meta?.width !== undefined && meta?.height !== undefined ? { width: meta.width, height: meta.height } : undefined,
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

    const pipeEdge = line.match(EDGE_WITH_PIPE_LABEL);
    if (pipeEdge) {
      const [, source, connector, label, target] = pipeEdge;
      pushEdge(source, connector, target, label);
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
      for (const hop of chain) pushEdge(hop.sourceToken, hop.connectorToken, hop.targetToken);
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
      const [, source, label, target] = inlineSolid;
      pushEdge(source, '-->', target, label);
      continue;
    }
    const inlineDotted = line.match(EDGE_INLINE_LABEL_DOTTED);
    if (inlineDotted) {
      const [, source, label, target] = inlineDotted;
      pushEdge(source, '-.->', target, label);
      continue;
    }
    const inlineThick = line.match(EDGE_INLINE_LABEL_THICK);
    if (inlineThick) {
      const [, source, label, target] = inlineThick;
      pushEdge(source, '==>', target, label);
      continue;
    }
    const plainEdge = line.match(EDGE_NO_LABEL);
    if (plainEdge) {
      const [, source, connector, target] = plainEdge;
      pushEdge(source, connector, target);
      continue;
    }

    let matchedNode = false;
    for (const { shape, regex } of NODE_PATTERNS) {
      const match = line.match(regex);
      if (match) {
        const [, id, label] = match;
        ensureNode(id, label, shape);
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
    if (!classStyle) continue;
    for (const nodeId of nodeIds) {
      const node = nodesById.get(nodeId);
      if (!node) continue;
      node.style = { ...node.style, ...classStyle };
    }
  }

  // Applied as a second pass since `style` lines conventionally follow the node/edge
  // declarations they target (and may reference nodes only implicitly declared via an edge).
  for (const { nodeId, propsRaw } of styleDirectives) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    node.style = { ...node.style, ...parseStyleProps(propsRaw) };
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
  model.nodes = Array.from(nodesById.values());
  model.containers = Array.from(containersById.values());
  model.edges = edges;
  return { model };
}
