import { inReadOrder } from './read-order.js';
import { parseFlowchart } from './flowchart-parser.js';
import { isAllowedLinkHref, type DiagramContainer, type DiagramModel, type DiagramNode, type NodeShape } from '../model/diagram-model.js';
import { joinFrontMatter, type CanvasFrontMatter, withLegend, withPinned, withLinks, withFrames } from './front-matter.js';
import { MAX_LINK_LENGTH, MERMAID_NAME, MERMAID_SHAPE_NAME, dataEntries, formatShapeData, mermaidShapeToCanvas } from './mermaid-shape-data.js';

const SHAPE_DELIMITERS: Record<NodeShape, [string, string]> = {
  rectangle: ['[', ']'],
  'rounded-rectangle': ['(', ')'],
  circle: ['((', '))'],
  diamond: ['{', '}'],
  cylinder: ['[(', ')]'],
  person: ['[', ']'],
  icon: ['[', ']'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  'double-circle': ['(((', ')))'],
  hexagon: ['{{', '}}'],
  parallelogram: ['[/', '/]'],
  'parallelogram-alt': ['[\\', '\\]'],
  trapezoid: ['[/', '\\]'],
  'trapezoid-alt': ['[\\', '/]'],
  asymmetric: ['>', ']'],
  // canvas-bnnh: state-diagram shapes have no flowchart form; the nearest one keeps the node.
  'state-start': ['((', '))'],
  'state-end': ['(((', ')))'],
  'fork-bar': ['[', ']'],
};

// canvas-tfr: a role that is a valid ID token round-trips as the node's Mermaid class (its
// standards element kind). Deliberately no `classDef` line: the parser's class pass would apply it
// over the node's own front-matter style, resetting a user-chosen swatch on every reload.
const CLASS_TOKEN = /^[A-Za-z0-9_]+$/;

// canvas-8wxq: a node read from `A@{ … }` is written back that way. Its Mermaid shape name is kept while it
// still fits the node's shape; once the shape is changed in Canvas, the shape's own Mermaid name is written.
function shapeData(node: DiagramNode): string | undefined {
  // An image address is checked again, as for click links: the model can be built without the parser.
  const extra = dataEntries(node.mermaidData, ['shape', 'label']).filter(
    ([key, value]) => key !== 'img' || (typeof value === 'string' && isAllowedLinkHref(value)),
  );
  const named = typeof node.mermaidShape === 'string' && MERMAID_NAME.test(node.mermaidShape) ? node.mermaidShape : undefined;
  if (named === undefined && extra.length === 0) return undefined;
  const entries: [string, unknown][] = [];
  if (named !== undefined && mermaidShapeToCanvas(named, !!node.icon) === node.shape) entries.push(['shape', named]);
  else if (named !== undefined || node.shape !== 'rectangle') entries.push(['shape', Object.hasOwn(MERMAID_SHAPE_NAME, node.shape) ? MERMAID_SHAPE_NAME[node.shape] : 'rect']);
  if (node.label !== node.id) entries.push(['label', node.label]);
  return formatShapeData([...entries, ...extra]);
}

function serializeNode(node: DiagramNode): string {
  const kindSuffix = node.role && CLASS_TOKEN.test(node.role) ? `:::${node.role}` : '';
  const data = shapeData(node);
  if (data !== undefined) return `  ${node.id}${kindSuffix}${data}`;
  const [open, close] = SHAPE_DELIMITERS[node.shape];
  return `  ${node.id}${open}${node.label}${close}${kindSuffix}`;
}

// jmuir-dzd.5: real Mermaid grammar (unlike style/classDef, which round-trip via front-matter,
// grouping C's own established precedent) -- `click` is native syntax, so it's re-emitted as a
// literal line, mirroring `direction`'s identical "real grammar, not a front-matter entry"
// treatment (grouping E). Placed after node/edge declarations, matching real Mermaid's own
// conventional click-directive placement.
//
// appsec review (jmuir-dzd.5): re-validates BOTH the scheme (isAllowedLinkHref) and the absence
// of `"`/newline in href/tooltip, defensively, even though setNodeLink (diagram-ops.ts) already
// enforces both at the one intended entry point -- a node.link is still just a plain object field
// on DiagramModel, reachable by anything that builds/mutates a model directly (a test fixture, a
// future code path that doesn't go through setNodeLink), and this file's own `"([^"]*)"` DSL
// token has no escape syntax for an embedded quote at all: an unescaped one would prematurely
// close the token, and a raw newline would inject an entirely separate DSL statement (e.g. a
// second, attacker-controlled `click <otherNodeId> href "javascript:..."` line targeting a
// DIFFERENT node whose own href was never validated) -- a stronger and differently-shaped risk
// than a mere malformed-syntax parse error, so a link that fails either check is treated exactly
// like "no link" here rather than emitted at all -- matches wrapNodeLink's (svg-renderer.ts) own
// "downgrade to unlinked, never emit something unsafe" precedent for the export boundary.
function serializeClickHref(node: DiagramNode): string | undefined {
  if (!node.link) return undefined;
  const { href, tooltip, target } = node.link;
  if (!isAllowedLinkHref(href)) return undefined;
  if (/["\r\n]/.test(href) || (tooltip !== undefined && /["\r\n]/.test(tooltip))) return undefined;
  const tooltipPart = tooltip !== undefined ? ` "${tooltip}"` : '';
  const targetPart = target === '_blank' ? ' _blank' : '';
  return `click ${node.id} href "${href}"${tooltipPart}${targetPart}`;
}

// Grouping B, canvas-sfz7: the link token for an edge's line style, arrowheads and Mermaid length. Both fields
// default to the common case (solid line, forward arrowhead) when unset on the edge.
function linkLength(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LINK_LENGTH ? value : 1;
}

function connectorFor(edge: DiagramModel['edges'][number]): string {
  const length = linkLength(edge.mermaidLength);
  if (edge.lineStyle === 'invisible') return '~'.repeat(length + 2);
  const arrow = edge.arrow === 'none' || edge.arrow === 'both' ? edge.arrow : 'target';
  const start = arrow === 'both' ? '<' : '';
  if (edge.lineStyle === 'dotted') return arrow === 'none' ? `-${'.'.repeat(length)}-` : `${start}-${'.'.repeat(length)}->`;
  const dash = edge.lineStyle === 'thick' ? '=' : '-';
  return arrow === 'none' ? dash.repeat(length + 2) : `${start}${dash.repeat(length + 1)}>`;
}

const EDGE_ID = /^[A-Za-z0-9_]+$/;

/** canvas-8wxq: each edge's Mermaid id worth writing (a valid id, the first edge to use it). */
function edgeIds(edges: DiagramModel['edges']): (string | undefined)[] {
  const used = new Set<string>();
  return edges.map((edge) => {
    const id = edge.mermaidId;
    if (typeof id !== 'string' || !EDGE_ID.test(id) || used.has(id)) return undefined;
    used.add(id);
    return id;
  });
}

function serializeEdge(edge: DiagramModel['edges'][number], mermaidId: string | undefined): string {
  const connector = `${mermaidId !== undefined ? `${mermaidId}@` : ''}${connectorFor(edge)}`;
  return edge.label
    ? `  ${edge.sourceId} ${connector}|${edge.label}| ${edge.targetId}`
    : `  ${edge.sourceId} ${connector} ${edge.targetId}`;
}

function serializeContainer(
  container: DiagramContainer,
  model: DiagramModel,
  emittedNodeIds: Set<string>,
): string[] {
  const lines: string[] = [];
  lines.push(`subgraph ${container.id} [${container.label}]`);
  if (container.direction) {
    lines.push(`  direction ${container.direction}`);
  }
  for (const node of model.nodes) {
    if (node.containerId === container.id) {
      lines.push(serializeNode(node));
      emittedNodeIds.add(node.id);
    }
  }
  for (const child of model.containers) {
    if (child.parentContainerId === container.id) {
      lines.push(...serializeContainer(child, model, emittedNodeIds).map((l) => `  ${l}`));
    }
  }
  lines.push('end');
  return lines;
}

/**
 * Serializes a DiagramModel back to Mermaid `flowchart` DSL (+ canvas front-matter for
 * positions/sizes/styles/icons that classic Mermaid grammar has no room for).
 */
/** Writes the model as Mermaid text, in the order reading it back gives (canvas-ra0g: see inReadOrder). */
export function serializeFlowchart(model: DiagramModel): string {
  return writeFlowchart(inReadOrder(model, parseFlowchart, writeFlowchart));
}

function writeFlowchart(model: DiagramModel): string {
  const frontMatter: CanvasFrontMatter = {
    canvas: {
      positions: Object.fromEntries(model.nodes.map((n) => [n.id, n.position])),
      containers: Object.fromEntries(
        model.containers
          .filter((c) => c.size)
          .map((c) => [c.id, { x: c.position.x, y: c.position.y, width: c.size!.width, height: c.size!.height }]),
      ),
      styles: Object.fromEntries(
        model.nodes.filter((n) => n.style).map((n) => [n.id, n.style!]),
      ),
      edgeStyles: Object.fromEntries(
        model.edges.filter((e) => e.style).map((e) => [e.id, e.style!]),
      ),
      icons: Object.fromEntries(
        model.nodes.filter((n) => n.icon).map((n) => [n.id, n.icon!]),
      ),
    },
  };

  const bodyLines: string[] = [`flowchart ${model.direction ?? 'TD'}`];
  if (model.title) bodyLines.push(`title ${model.title}`);
  if (model.mermaidConfigDirective) bodyLines.unshift(model.mermaidConfigDirective);
  if (model.accTitle) bodyLines.push(`accTitle: ${model.accTitle}`);
  if (model.accDescr) bodyLines.push(`accDescr: ${model.accDescr}`);
  const emittedNodeIds = new Set<string>();

  const topLevelContainers = model.containers.filter((c) => !c.parentContainerId);
  for (const container of topLevelContainers) {
    bodyLines.push(...serializeContainer(container, model, emittedNodeIds));
  }
  for (const node of model.nodes) {
    if (!emittedNodeIds.has(node.id)) {
      bodyLines.push(serializeNode(node));
    }
  }
  const ids = edgeIds(model.edges);
  model.edges.forEach((edge, i) => bodyLines.push(serializeEdge(edge, ids[i])));
  // canvas-8wxq: an edge's options follow the edges, as Mermaid applies them only to an edge already read.
  model.edges.forEach((edge, i) => {
    const entries = dataEntries(edge.mermaidData);
    if (ids[i] !== undefined && entries.length > 0) bodyLines.push(`  ${ids[i]}${formatShapeData(entries)}`);
  });
  // canvas-lwa4: a subgraph's options, after every subgraph has been declared.
  for (const container of model.containers) {
    const entries = dataEntries(container.mermaidData);
    if (entries.length > 0 && /^[A-Za-z0-9_]+$/.test(container.id)) bodyLines.push(`  ${container.id}${formatShapeData(entries)}`);
  }
  for (const node of model.nodes) {
    const clickLine = serializeClickHref(node);
    if (clickLine) bodyLines.push(clickLine);
  }

  const body = `${bodyLines.join('\n')}\n`;
  return joinFrontMatter(withFrames(withLinks(withPinned(withLegend(frontMatter, model), model), model), model), body);
}
