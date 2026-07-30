import type { DiagramNode, NodeShape } from '@canvas/diagram-core';

export const DEFAULT_NODE_SIZE = { width: 140, height: 60 };

export function nodeSize(node: DiagramNode): { width: number; height: number } {
  return node.size ?? DEFAULT_NODE_SIZE;
}

/**
 * Selection highlight — screen only, and deliberately the ONLY visual change this redesign makes
 * to diagram elements (FR-025). It is recoloured to the interface accent purely for palette
 * consistency, and is safe to change because selection is never exported: the export renderer
 * (packages/diagram-core/src/render/svg-renderer.ts) has no concept of it.
 *
 * Node fill, stroke, and label styling are untouched — those come from admin-defined standards
 * and are produced by both renderers, which must agree for exports to match the canvas (SC-004).
 */
const SELECTION_STROKE = '#2563eb';

export function renderNodeShape(node: DiagramNode, selected: boolean): JSX.Element {
  const { x, y } = node.position;
  const { width, height } = nodeSize(node);
  const fill = node.style?.fillColor ?? '#ffffff';
  const stroke = selected ? SELECTION_STROKE : (node.style?.strokeColor ?? '#333333');
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
    case 'stadium':
      return (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={height / 2}
          ry={height / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case 'subroutine': {
      const inset = Math.min(10, width / 6);
      return (
        <g>
          <rect x={x} y={y} width={width} height={height} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
          <line x1={x + inset} y1={y} x2={x + inset} y2={y + height} stroke={stroke} strokeWidth={strokeWidth} />
          <line
            x1={x + width - inset}
            y1={y}
            x2={x + width - inset}
            y2={y + height}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        </g>
      );
    }
    case 'double-circle': {
      const gap = 5;
      return (
        <g>
          <ellipse
            cx={x + width / 2}
            cy={y + height / 2}
            rx={width / 2}
            ry={height / 2}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <ellipse
            cx={x + width / 2}
            cy={y + height / 2}
            rx={width / 2 - gap}
            ry={height / 2 - gap}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
        </g>
      );
    }
    case 'hexagon': {
      const notch = Math.min(20, width / 4);
      const points = [
        [x + notch, y],
        [x + width - notch, y],
        [x + width, y + height / 2],
        [x + width - notch, y + height],
        [x + notch, y + height],
        [x, y + height / 2],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }
    case 'parallelogram': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x + skew, y],
        [x + width, y],
        [x + width - skew, y + height],
        [x, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }
    case 'parallelogram-alt': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x, y],
        [x + width - skew, y],
        [x + width, y + height],
        [x + skew, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }
    case 'trapezoid': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x + skew, y],
        [x + width - skew, y],
        [x + width, y + height],
        [x, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }
    case 'trapezoid-alt': {
      const skew = Math.min(20, width / 5);
      const points = [
        [x, y],
        [x + width, y],
        [x + width - skew, y + height],
        [x + skew, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }
    case 'asymmetric': {
      const notch = Math.min(20, width / 5);
      const points = [
        [x, y],
        [x + width - notch, y],
        [x + width, y + height / 2],
        [x + width - notch, y + height],
        [x, y + height],
      ]
        .map((p) => p.join(','))
        .join(' ');
      return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
    }
    default:
      return <rect x={x} y={y} width={width} height={height} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
  }
}

const UNIVERSAL_SHAPES: { shape: NodeShape; label: string }[] = [
  { shape: 'rectangle', label: 'Rectangle' },
  { shape: 'rounded-rectangle', label: 'Rounded' },
  { shape: 'circle', label: 'Circle' },
  { shape: 'diamond', label: 'Diamond' },
];

// Default orientation only — parallelogram-alt/trapezoid-alt are reachable via DSL/import but get
// no toolbar button (data-model.md: orientation is a distinct shape value, but only one per pair
// is a first-class authoring affordance).
const FLOWCHART_ONLY_SHAPES: { shape: NodeShape; label: string }[] = [
  { shape: 'stadium', label: 'Stadium' },
  { shape: 'subroutine', label: 'Subroutine' },
  { shape: 'double-circle', label: 'Double Circle' },
  { shape: 'hexagon', label: 'Hexagon' },
  { shape: 'parallelogram', label: 'Parallelogram' },
  { shape: 'trapezoid', label: 'Trapezoid' },
  { shape: 'asymmetric', label: 'Asymmetric' },
];

/** Scoped by `dslFamily`, not `diagramTypeId` — several diagram types share the flowchart family
 *  (e.g. `business-capability-map`) and must offer these shapes too, not just `id: 'flowchart'`. */
export function getAddableShapes(dslFamily: string): { shape: NodeShape; label: string }[] {
  return dslFamily === 'flowchart' ? [...UNIVERSAL_SHAPES, ...FLOWCHART_ONLY_SHAPES] : UNIVERSAL_SHAPES;
}
