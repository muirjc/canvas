import type { DiagramContainer, DiagramModel, DiagramNode, NodeShape } from '../model/diagram-model.js';
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

  const body = `${bodyLines.join('\n')}\n`;
  return joinFrontMatter(frontMatter, body);
}
