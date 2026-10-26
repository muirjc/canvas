import { LEGEND_METRICS, type DiagramNode, type LegendLayout } from '@canvas/diagram-core';
import { renderNodeShape } from './shapes';

const LINE_DASH: Record<string, string> = { dotted: '4,3', invisible: '2,4' };

export interface LegendBoxProps {
  layout: LegendLayout;
  diagramTypeId?: string;
  onPointerDown: (event: React.PointerEvent) => void;
  onDoubleClick: () => void;
}

/**
 * canvas-ltk: the diagram legend on the interactive canvas. Geometry comes from the same
 * `legendLayout` the export renderer uses, and the sample drawing mirrors `renderLegend`
 * (svg-renderer.ts) -- shapes go through the canvas's own `renderNodeShape` so a sample matches the
 * shapes drawn on the canvas. The testid deliberately doesn't start with node-/edge-/container-.
 */
export function LegendBox({ layout, diagramTypeId, onPointerDown, onDoubleClick }: LegendBoxProps) {
  const m = LEGEND_METRICS;
  return (
    <g
      data-testid="diagram-legend"
      className="canvas-legend"
      style={{ cursor: 'move' }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      <rect x={layout.x} y={layout.y} width={layout.width} height={layout.height} rx={6} ry={6} fill="#ffffff" stroke="#cccccc" />
      {layout.title && (
        <text x={layout.title.x} y={layout.title.y} fontFamily="sans-serif" fontSize={m.fontSize} fontWeight="bold" fill="#333333">
          {layout.title.text}
        </text>
      )}
      {layout.rows.map((row) => {
        const midY = row.y + m.rowHeight / 2;
        const sample = row.entry.sample;
        let glyph: JSX.Element;
        if (sample.kind === 'shape') {
          const w = sample.shape === 'person' ? m.sampleHeight : m.sampleWidth;
          const node: DiagramNode = {
            id: `legend-${row.entry.key}`,
            label: '',
            shape: sample.shape,
            position: { x: row.sampleX + (m.sampleWidth - w) / 2, y: midY - m.sampleHeight / 2 },
            size: { width: w, height: m.sampleHeight },
            style: { ...(sample.fill ? { fillColor: sample.fill } : {}), ...(sample.stroke ? { strokeColor: sample.stroke } : {}) },
          };
          glyph = renderNodeShape(node, false, diagramTypeId);
        } else {
          const dash = LINE_DASH[sample.lineStyle ?? ''];
          glyph = (
            <line
              x1={row.sampleX}
              y1={midY}
              x2={row.sampleX + m.sampleWidth}
              y2={midY}
              stroke={sample.stroke ?? '#333333'}
              strokeWidth={sample.lineStyle === 'thick' ? 3 : 1.5}
              strokeDasharray={dash}
              markerEnd={sample.arrow === 'target' || sample.arrow === 'both' || sample.arrow === undefined ? 'url(#arrow)' : undefined}
              markerStart={sample.arrow === 'source' || sample.arrow === 'both' ? 'url(#arrow)' : undefined}
            />
          );
        }
        return (
          <g key={row.entry.key} data-testid={`diagram-legend-row-${row.entry.key}`}>
            {glyph}
            <text x={row.labelX} y={midY + m.fontSize / 3} fontFamily="sans-serif" fontSize={m.fontSize} fill="#333333">
              {row.entry.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
