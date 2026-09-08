import { isAllowedLinkHref, type DiagramContainer, type DiagramModel, type DiagramNode, type NodeShape } from '../model/diagram-model.js';
import { joinFrontMatter, type CanvasFrontMatter } from './front-matter.js';

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
};

function serializeNode(node: DiagramNode): string {
  const [open, close] = SHAPE_DELIMITERS[node.shape];
  return `  ${node.id}${open}${node.label}${close}`;
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

// Grouping B: which literal connector token represents a given (lineStyle, arrow) pair. Both
// fields default to the common case (solid line, forward arrowhead) when unset on the edge.
const CONNECTOR_TOKENS: Record<'solid' | 'dotted' | 'thick', Record<'none' | 'target' | 'both', string>> = {
  solid: { none: '---', target: '-->', both: '<-->' },
  dotted: { none: '-.-', target: '-.->', both: '<-.->' },
  thick: { none: '===', target: '==>', both: '<==>' },
};

function connectorFor(edge: DiagramModel['edges'][number]): string {
  if (edge.lineStyle === 'invisible') return '~~~';
  const lineStyle = edge.lineStyle ?? 'solid';
  const arrow = edge.arrow === 'none' || edge.arrow === 'both' ? edge.arrow : 'target';
  return CONNECTOR_TOKENS[lineStyle][arrow];
}

function serializeEdge(edge: DiagramModel['edges'][number]): string {
  const connector = connectorFor(edge);
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
export function serializeFlowchart(model: DiagramModel): string {
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
  for (const edge of model.edges) {
    bodyLines.push(serializeEdge(edge));
  }
  for (const node of model.nodes) {
    const clickLine = serializeClickHref(node);
    if (clickLine) bodyLines.push(clickLine);
  }

  const body = `${bodyLines.join('\n')}\n`;
  return joinFrontMatter(frontMatter, body);
}
