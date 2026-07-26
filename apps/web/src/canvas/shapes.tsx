import type { DiagramNode, NodeShape } from '@canvas/diagram-core';

export const DEFAULT_NODE_SIZE = { width: 140, height: 60 };

export function nodeSize(node: DiagramNode): { width: number; height: number } {
  return node.size ?? DEFAULT_NODE_SIZE;
}

export function renderNodeShape(node: DiagramNode, selected: boolean): JSX.Element {
  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const fill = node.style?.fillColor ?? '#ffffff';
  const stroke = selected ? '#1168bd' : (node.style?.strokeColor ?? '#333333');
  const strokeWidth = selected ? 2 : 1;

  switch (node.shape) {
    case 'circle':
      return (
        <ellipse
          cx={x + width / 2}
          cy={y + height / 2}
          rx={width / 2}
          ry={height / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case 'diamond': {
      const points = [
        [x + width / 2, y],
        [x + width, y + height / 2],
        [x + width / 2, y + height],
        [x, y + height / 2],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }
    case 'rounded-rectangle':
      return (
        <rect x={x} y={y} width={width} height={height} rx={12} ry={12} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
      );
    default:
      return <rect x={x} y={y} width={width} height={height} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
  }
}

export const ADDABLE_SHAPES: { shape: NodeShape; label: string }[] = [
  { shape: 'rectangle', label: 'Rectangle' },
  { shape: 'rounded-rectangle', label: 'Rounded' },
  { shape: 'circle', label: 'Circle' },
  { shape: 'diamond', label: 'Diamond' },
];
