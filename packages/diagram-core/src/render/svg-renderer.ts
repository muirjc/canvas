import type { DiagramContainer, DiagramModel, DiagramNode, Size } from '../model/diagram-model.js';

const DEFAULT_NODE_SIZE: Size = { width: 140, height: 60 };
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nodeSize(node: DiagramNode): Size {
  return node.size ?? DEFAULT_NODE_SIZE;
}

function nodeCenter(node: DiagramNode): { x: number; y: number } {
  const size = nodeSize(node);
  return { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
}

function renderNodeShape(node: DiagramNode): string {
  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const fill = node.style?.fillColor ?? '#ffffff';
  const stroke = node.style?.strokeColor ?? '#333333';

  switch (node.shape) {
    case 'circle':
      return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" />`;
    case 'diamond': {
      const points = [
        [x + width / 2, y],
        [x + width, y + height / 2],
        [x + width / 2, y + height],
        [x, y + height / 2],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" />`;
    }
    case 'cylinder': {
      const capHeight = Math.min(16, height / 4);
      return [
        `<path d="M ${x} ${y + capHeight} L ${x} ${y + height - capHeight} A ${width / 2} ${capHeight} 0 0 0 ${x + width} ${y + height - capHeight} L ${x + width} ${y + capHeight} A ${width / 2} ${capHeight} 0 0 0 ${x} ${y + capHeight} Z" fill="${fill}" stroke="${stroke}" />`,
        `<ellipse cx="${x + width / 2}" cy="${y + capHeight}" rx="${width / 2}" ry="${capHeight}" fill="${fill}" stroke="${stroke}" />`,
      ].join('');
    }
    case 'rounded-rectangle':
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" ry="12" fill="${fill}" stroke="${stroke}" />`;
    case 'person':
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" ry="24" fill="${fill}" stroke="${stroke}" />`;
    case 'icon':
    case 'rectangle':
    default:
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" stroke="${stroke}" />`;
  }
}

export type IconResolver = (icon: NonNullable<DiagramNode['icon']>) => string | undefined;

function renderNode(node: DiagramNode, resolveIcon?: IconResolver): string {
  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const fontSize = node.style?.fontSize ?? 14;

  const iconMarkup = node.icon ? resolveIcon?.(node.icon) : undefined;
  if (iconMarkup) {
    // Icon assets are authored on a normalized 48x48 viewBox; scale/position into the node's box.
    const iconSize = Math.min(width, height) * 0.6;
    const iconX = x + (width - iconSize) / 2;
    const iconY = y + (height - iconSize) / 2 - 8;
    return [
      `<g data-node-id="${escapeXml(node.id)}">`,
      renderNodeShape(node),
      `<g transform="translate(${iconX}, ${iconY}) scale(${iconSize / 48})">${iconMarkup}</g>`,
      `<text x="${x + width / 2}" y="${y + height - 10}" text-anchor="middle" font-size="${Math.max(fontSize - 2, 10)}" font-family='${FONT_FAMILY}'>${escapeXml(node.label)}</text>`,
      '</g>',
    ].join('');
  }

  const label = node.icon ? `${escapeXml(node.label)} [${escapeXml(node.icon.iconId)}]` : escapeXml(node.label);
  return [
    `<g data-node-id="${escapeXml(node.id)}">`,
    renderNodeShape(node),
    `<text x="${x + width / 2}" y="${y + height / 2}" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize}" font-family='${FONT_FAMILY}'>${label}</text>`,
    '</g>',
  ].join('');
}

function renderContainer(container: DiagramContainer): string {
  const { x, y } = container.position;
  const { width, height } = container.size ?? { width: 300, height: 200 };
  return [
    `<g data-container-id="${escapeXml(container.id)}">`,
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#888888" stroke-dasharray="6,4" />`,
    `<text x="${x + 8}" y="${y + 16}" font-size="12" font-family='${FONT_FAMILY}'>${escapeXml(container.label)}</text>`,
    '</g>',
  ].join('');
}

function renderEdge(edge: DiagramModel['edges'][number], nodesById: Map<string, DiagramNode>): string {
  const source = nodesById.get(edge.sourceId);
  const target = nodesById.get(edge.targetId);
  if (!source || !target) return '';
  const from = nodeCenter(source);
  const to = nodeCenter(target);
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const label = edge.label
    ? `<text x="${midX}" y="${midY - 4}" text-anchor="middle" font-size="12" font-family='${FONT_FAMILY}'>${escapeXml(edge.label)}</text>`
    : '';
  return `<g data-edge-id="${escapeXml(edge.id)}"><line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#333333" marker-end="url(#arrowhead)" />${label}</g>`;
}

function computeBounds(model: DiagramModel): { width: number; height: number } {
  let maxX = 400;
  let maxY = 300;
  for (const node of model.nodes) {
    const size = nodeSize(node);
    maxX = Math.max(maxX, node.position.x + size.width + 40);
    maxY = Math.max(maxY, node.position.y + size.height + 40);
  }
  for (const container of model.containers) {
    const size = container.size ?? { width: 300, height: 200 };
    maxX = Math.max(maxX, container.position.x + size.width + 40);
    maxY = Math.max(maxY, container.position.y + size.height + 40);
  }
  return { width: maxX, height: maxY };
}

/**
 * Renders a DiagramModel to self-contained SVG: no external network calls, no remote fonts —
 * satisfies the constitution's export constraint and Contract IV's export-fidelity requirement.
 */
export function renderToSvg(model: DiagramModel, resolveIcon?: IconResolver): string {
  const nodesById = new Map(model.nodes.map((n) => [n.id, n]));
  const { width, height } = computeBounds(model);

  const containerMarkup = model.containers.map(renderContainer).join('');
  const edgeMarkup = model.edges.map((e) => renderEdge(e, nodesById)).join('');
  const nodeMarkup = model.nodes.map((n) => renderNode(n, resolveIcon)).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<defs>',
    '<marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">',
    '<path d="M0,0 L0,6 L9,3 z" fill="#333333" />',
    '</marker>',
    '</defs>',
    containerMarkup,
    edgeMarkup,
    nodeMarkup,
    '</svg>',
  ].join('');
}
