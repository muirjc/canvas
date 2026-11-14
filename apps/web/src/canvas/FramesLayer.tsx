// canvas-8uh1.6: frames -- other diagrams drawn over this one (docs/composite-diagrams-design.md). Each frame shows the
// inner diagram's latest saved drawing (from the API, made by the same renderer as an export, as an image so nothing
// in it runs), scaled to fit under a header with its title and Open. A frame is selected, moved and resized like a
// group; it can't be edited inside (Open goes to the diagram). Frames sit on top of the diagram.
import { useRef } from 'react';
import { FRAME_HEADER_HEIGHT, frameStatusText, frameTitle, type DiagramFrame, type FrameContent, type Position, type Size } from '@canvas/diagram-core';
import { SELECTION_STROKE } from './shapes';

export interface FramesLayerProps {
  frames: DiagramFrame[];
  /** What each framed diagram shows, by diagram id (absent = still loading). */
  contents: Map<string, FrameContent>;
  selectedFrameId: string | null;
  readOnly: boolean;
  /** Screen point -> diagram units (the canvas's zoom taken into account). */
  toCanvasPoint: (event: React.PointerEvent) => Position;
  onSelect: (frameId: string) => void;
  onMove: (frameId: string, position: Position) => void;
  onResize: (frameId: string, size: Size) => void;
  onOpen: (diagramId: string) => void;
}

const HANDLE = 14;
/** The resize handle's grab area (bigger than what is drawn). */
const HANDLE_HIT = 24;
const OPEN_WIDTH = 56;

/** The inner drawing as an image source: a complete SVG document, so the browser never runs anything in it. */
function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

type Drag = { kind: 'move'; id: string; offset: Position } | { kind: 'resize'; id: string; origin: Position };

export function FramesLayer({ frames, contents, selectedFrameId, readOnly, toCanvasPoint, onSelect, onMove, onResize, onOpen }: FramesLayerProps) {
  const drag = useRef<Drag | null>(null);

  const start = (event: React.PointerEvent, next: Drag) => {
    event.stopPropagation();
    if (readOnly) return;
    drag.current = next;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };
  const move = (event: React.PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    event.stopPropagation();
    const point = toCanvasPoint(event);
    if (current.kind === 'move') onMove(current.id, { x: Math.round(point.x - current.offset.x), y: Math.round(point.y - current.offset.y) });
    else onResize(current.id, { width: Math.round(point.x - current.origin.x), height: Math.round(point.y - current.origin.y) });
  };
  const end = (event: React.PointerEvent) => {
    if (!drag.current) return;
    event.stopPropagation();
    drag.current = null;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  };

  return (
    <g className="diagram-frames">
      {frames.map((frame) => {
        const { x, y } = frame.position;
        const { width, height } = frame.size;
        const content = contents.get(frame.diagramId);
        const status = content?.status ?? 'checking';
        const selected = selectedFrameId === frame.id;
        const bodyHeight = Math.max(0, height - FRAME_HEADER_HEIGHT);
        const showDrawing = content?.status === 'available' && content.svg !== undefined;
        const title = content ? frameTitle(content, width - OPEN_WIDTH) : 'Loading…';
        return (
          <g
            key={frame.id}
            data-testid={`diagram-frame-${frame.id}`}
            data-status={status}
            className="diagram-frame"
            role="group"
            aria-label={`Embedded diagram: ${content?.name ?? 'loading'}`}
            onPointerDown={(event) => {
              onSelect(frame.id);
              const point = toCanvasPoint(event);
              start(event, { kind: 'move', id: frame.id, offset: { x: point.x - x, y: point.y - y } });
            }}
            onPointerMove={move}
            onPointerUp={end}
            onClick={(event) => event.stopPropagation()}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                event.stopPropagation();
                onSelect(frame.id);
              }
            }}
            style={{ cursor: readOnly ? 'default' : 'move' }}
          >
            <rect className="diagram-frame__ring" x={x - 3} y={y - 3} width={width + 6} height={height + 6} rx={8} fill="none" pointerEvents="none" />
            <rect x={x} y={y} width={width} height={height} rx={6} fill="#ffffff" stroke={selected ? SELECTION_STROKE : '#64748b'} strokeWidth={selected ? 2.5 : 1.5} />
            <rect x={x} y={y} width={width} height={Math.min(height, FRAME_HEADER_HEIGHT)} rx={6} fill="#e2e8f0" stroke={selected ? SELECTION_STROKE : '#64748b'} strokeWidth={selected ? 2.5 : 1.5} />
            <text x={x + 8} y={y + 16} fontSize={12} fontWeight="bold" fill="#1e293b" style={{ userSelect: 'none' }} pointerEvents="none">
              {title}
            </text>
            {showDrawing ? (
              <image href={svgDataUri(content.svg!)} x={x} y={y + FRAME_HEADER_HEIGHT} width={width} height={bodyHeight} preserveAspectRatio="xMidYMid meet" pointerEvents="none" />
            ) : (
              <text x={x + width / 2} y={y + FRAME_HEADER_HEIGHT + bodyHeight / 2} fontSize={12} fill="#64748b" textAnchor="middle" dominantBaseline="central" pointerEvents="none" style={{ userSelect: 'none' }} data-testid={`frame-placeholder-${frame.id}`}>
                {content ? frameStatusText(content) || 'Embedded diagram' : 'Loading…'}
              </text>
            )}
            {status === 'available' && (
              <foreignObject x={x + width - OPEN_WIDTH} y={y + 2} width={OPEN_WIDTH - 4} height={FRAME_HEADER_HEIGHT - 4}>
                <button
                  type="button"
                  className="diagram-frame__open"
                  data-testid={`frame-open-${frame.id}`}
                  aria-label={`Open ${content?.name ?? 'the embedded diagram'}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(frame.diagramId);
                  }}
                >
                  Open
                </button>
              </foreignObject>
            )}
            {selected && !readOnly && (
              <g
                data-testid={`frame-resize-${frame.id}`}
                style={{ cursor: 'nwse-resize' }}
                aria-hidden="true"
                onPointerDown={(event) => start(event, { kind: 'resize', id: frame.id, origin: { x, y } })}
                onPointerMove={move}
                onPointerUp={end}
              >
                <rect x={x + width - HANDLE_HIT / 2} y={y + height - HANDLE_HIT / 2} width={HANDLE_HIT} height={HANDLE_HIT} fill="transparent" />
                <rect x={x + width - HANDLE / 2} y={y + height - HANDLE / 2} width={HANDLE} height={HANDLE} rx={2} fill={SELECTION_STROKE} stroke="#ffffff" strokeWidth={1.5} pointerEvents="none" />
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}
