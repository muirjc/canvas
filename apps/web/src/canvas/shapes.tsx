import { iconNodeSize, tableNodeLayout, type DiagramNode, type NodeShape } from '@canvas/diagram-core';

export const DEFAULT_NODE_SIZE = { width: 140, height: 60 };

// canvas-23t.5: an icon node with no explicit size gets a content-fit box (icon glyph + wrapped
// caption) instead of the flat text-node default — `iconNodeSize` is the single shared
// calculation (packages/diagram-core/src/render/svg-renderer.ts), reused here rather than
// re-derived, so the canvas and the export renderer can't disagree about an icon node's size.
// canvas-x66: same precedent for a node with attribute/member rows (ER/UML) — `tableNodeLayout`
// already computes the content-fit size as part of its own layout, so its `width`/`height` are
// reused here rather than adding a third size calculation next to `iconNodeSize`'s.
export function nodeSize(node: DiagramNode): { width: number; height: number } {
  if (node.shape === 'icon' && !node.size) return iconNodeSize(node);
  if (!node.size) {
    const tableLayout = tableNodeLayout(node);
    if (tableLayout) return { width: tableLayout.width, height: tableLayout.height };
  }
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
export const SELECTION_STROKE = '#2563eb';

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
    case 'cylinder': {
      // canvas-8n7: was silently falling through to a plain rectangle — mirrors
      // svg-renderer.ts's cylinder case exactly (SC-004) rather than reimplementing it.
      const capHeight = Math.min(16, height / 4);
      return (
        <g>
          <path
            d={`M ${x} ${y + capHeight} L ${x} ${y + height - capHeight} A ${width / 2} ${capHeight} 0 0 0 ${x + width} ${y + height - capHeight} L ${x + width} ${y + capHeight} A ${width / 2} ${capHeight} 0 0 0 ${x} ${y + capHeight} Z`}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <ellipse cx={x + width / 2} cy={y + capHeight} rx={width / 2} ry={capHeight} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
        </g>
      );
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
  // canvas-7vs.10: sequence diagrams have no toolbar-addable shape at all. A participant/actor is
  // how a sequence diagram gains a new lifeline (its own DSL-level declaration) — offering the
  // four universal shapes here was a real, confirmed bug, not a missing feature: serializeSequence
  // re-emits every node as a plain participant/actor line regardless of its shape field, so a
  // toolbar-added node's shape was visibly added but silently discarded on the very next save.
  // Fixing the actual gap means not offering a shape vocabulary this family's own DSL grammar has
  // no room for, rather than half-supporting it.
  if (dslFamily === 'sequence') return [];
  // canvas-hox follow-up: every node in an ER diagram is an entity, and erd.ts's own parser only
  // ever produces plain rectangles for one (there is no ER-notation equivalent of a rounded
  // rectangle/circle/diamond entity) -- offering the other three universal shapes here was
  // authoring a shape choice the DSL itself has no room for, the same class of gap
  // canvas-7vs.10 fixed for sequence diagrams above.
  if (dslFamily === 'erd') return [{ shape: 'rectangle', label: 'Rectangle' }];
  return dslFamily === 'flowchart' ? [...UNIVERSAL_SHAPES, ...FLOWCHART_ONLY_SHAPES] : UNIVERSAL_SHAPES;
}
