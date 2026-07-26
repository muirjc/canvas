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
};

function serializeNode(node: DiagramNode): string {
  const [open, close] = SHAPE_DELIMITERS[node.shape];
  return `  ${node.id}${open}${node.label}${close}`;
}

function serializeEdge(edge: DiagramModel['edges'][number]): string {
  return edge.label
    ? `  ${edge.sourceId} -->|${edge.label}| ${edge.targetId}`
    : `  ${edge.sourceId} --> ${edge.targetId}`;
}

function serializeContainer(
  container: DiagramContainer,
  model: DiagramModel,
  emittedNodeIds: Set<string>,
): string[] {
  const lines: string[] = [];
  lines.push(`subgraph ${container.id} [${container.label}]`);
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
      icons: Object.fromEntries(
        model.nodes.filter((n) => n.icon).map((n) => [n.id, n.icon!]),
      ),
    },
  };

  const bodyLines: string[] = [`flowchart ${model.direction ?? 'TD'}`];
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
