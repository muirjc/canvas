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

const EDGE_WITH_PIPE_LABEL = new RegExp(`^(${TOKEN})\\s*-->\\s*\\|(.+?)\\|\\s*(${TOKEN})$`);
const EDGE_WITH_INLINE_LABEL = new RegExp(`^(${TOKEN})\\s*--\\s*(.+?)\\s*-->\\s*(${TOKEN})$`);
const EDGE_NO_LABEL = new RegExp(`^(${TOKEN})\\s*-->\\s*(${TOKEN})$`);
const SUBGRAPH_START = new RegExp(`^subgraph\\s+(${ID})(?:\\s*\\[(.+)\\])?$`);
const SUBGRAPH_END = /^end$/;
const BARE_ID = new RegExp(`^(${ID})$`);
const HEADER = /^(?:flowchart|graph)\s+(TD|LR|TB|RL|BT)$/i;
const STYLE_DIRECTIVE = new RegExp(`^style\\s+(${ID})\\s+(.+)$`);
// Mermaid addresses links by their 0-based declaration order (the Nth edge line encountered),
// not by the platform's internal e1/e2 ids — "default" applies the style to every edge.
const LINK_STYLE_DIRECTIVE = /^linkStyle\s+(default|\d+(?:\s*,\s*\d+)*)\s+(.+)$/;

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

  const lines = body.split(/\r?\n/);
  const errors: ParseError[] = [];
  const nodesById = new Map<string, DiagramNode>();
  const containersById = new Map<string, DiagramContainer>();
  const edges: { id: string; sourceId: string; targetId: string; label?: string; style?: NodeStyle }[] = [];
  const containerStack: string[] = [];
  const styleDirectives: { nodeId: string; propsRaw: string }[] = [];
  const linkStyleDirectives: { indices: number[] | 'default'; propsRaw: string }[] = [];
  let diagramTypeSeen = false;
  let direction: FlowchartDirection | undefined;
  let edgeCounter = 0;

  const ensureNode = (id: string, label: string, shape: NodeShape): DiagramNode => {
    let node = nodesById.get(id);
    if (!node) {
      node = {
        id,
        label,
        shape,
        position: positions[id] ?? nextAutoPosition(),
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

    const subgraphMatch = line.match(SUBGRAPH_START);
    if (subgraphMatch) {
      const [, id, label] = subgraphMatch;
      const meta = containerMeta[id];
      containersById.set(id, {
        id,
        label: label ?? id,
        position: meta ? { x: meta.x, y: meta.y } : nextAutoPosition(),
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

    const pipeEdge = line.match(EDGE_WITH_PIPE_LABEL);
    if (pipeEdge) {
      const [, source, label, target] = pipeEdge;
      edgeCounter += 1;
      const id = `e${edgeCounter}`;
      edges.push({ id, sourceId: resolveEdgeEndpoint(source), targetId: resolveEdgeEndpoint(target), label, style: edgeStyles[id] });
      continue;
    }
    const inlineEdge = line.match(EDGE_WITH_INLINE_LABEL);
    if (inlineEdge) {
      const [, source, label, target] = inlineEdge;
      edgeCounter += 1;
      const id = `e${edgeCounter}`;
      edges.push({ id, sourceId: resolveEdgeEndpoint(source), targetId: resolveEdgeEndpoint(target), label, style: edgeStyles[id] });
      continue;
    }
    const plainEdge = line.match(EDGE_NO_LABEL);
    if (plainEdge) {
      const [, source, target] = plainEdge;
      edgeCounter += 1;
      const id = `e${edgeCounter}`;
      edges.push({ id, sourceId: resolveEdgeEndpoint(source), targetId: resolveEdgeEndpoint(target), style: edgeStyles[id] });
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

  const model = createEmptyDiagramModel('flowchart');
  model.direction = direction;
  model.nodes = Array.from(nodesById.values());
  model.containers = Array.from(containersById.values());
  model.edges = edges;
  return { model };
}
