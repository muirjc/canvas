// canvas-4h1j.2: a Wardley map in the editor. Drawn from computeWardleyLayout, the geometry the export renderer
// (diagram-core's render/wardley-render.ts) uses, so the editor and the exported SVG agree: the frame, axes and
// evolution stages, pipelines, links, evolve arrows, components (strategy rings, inertia bars), anchors, notes,
// annotations and (de)accelerators. Elements and links are pointer targets (selection, dragging, connecting);
// Canvas owns what a pointer does. Test ids start with `wardley-`, never `node-`/`edge-`, which e2e specs count.
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { computeWardleyLayout, isWardleyMapNode, type DiagramEdge, type DiagramModel, type DiagramNode, type Position } from '@canvas/diagram-core';
import { SELECTION_STROKE } from './shapes';

const NODE_RADIUS = 6;
const SQUARE = NODE_RADIUS * 1.6;
const LABEL_OFFSET = 8;
const LABEL_FONT = 10;
const AXIS_FONT = 12;
const TEXT = '#222';
const STROKE = '#000';
const EVOLVE = '#dc3545';
const CONNECT_SOURCE = '#16a34a';
const RING: Record<string, string> = { outsource: '#666', buy: '#ccc', build: '#eee', market: 'white' };
/** svg-renderer's text-width estimate. */
const CHAR_WIDTH = 0.56;

export interface WardleyLayerProps {
  model: DiagramModel;
  selectedIds: Set<string>;
  selectedEdgeId: string | null;
  connectSourceId: string | null;
  onElementPointerDown: (node: DiagramNode) => (event: ReactPointerEvent) => void;
  onLinkPointerDown: (edgeId: string) => (event: ReactPointerEvent) => void;
}

/** A dashed outline around a selected element (or a green one around the connect source). */
function Highlight({ x, y, width, height, color }: { x: number; y: number; width: number; height: number; color: string }) {
  return <rect x={x - 4} y={y - 4} width={width + 8} height={height + 8} rx={4} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="4 2" pointerEvents="none" />;
}

function textBox(text: string, x: number, y: number, size: number, anchor: 'start' | 'middle') {
  const width = Math.max(text.length * size * CHAR_WIDTH, size);
  return { x: anchor === 'middle' ? x - width / 2 : x, y: y - size, width, height: size * 1.3 };
}

export function WardleyLayer({ model, selectedIds, selectedEdgeId, connectSourceId, onElementPointerDown, onLinkPointerDown }: WardleyLayerProps) {
  const layout = computeWardleyLayout(model);
  const { frame } = layout;
  const { width, height, padding, chartWidth, chartHeight } = frame;
  const highlightColor = (id: string) => (connectSourceId === id ? CONNECT_SOURCE : selectedIds.has(id) ? SELECTION_STROKE : undefined);

  const childrenOf = new Map<string, Set<string>>();
  for (const container of model.containers) {
    const parent = container.attachedNodeIds?.[0];
    if (container.role === 'pipeline' && parent !== undefined) {
      childrenOf.set(parent, new Set(model.nodes.filter((n) => n.containerId === container.id).map((n) => n.id)));
    }
  }

  const renderLink = (edge: DiagramEdge) => {
    // Mermaid leaves out a link from a pipeline component to its own parent.
    if (childrenOf.get(edge.targetId)?.has(edge.sourceId)) return null;
    const from = layout.points.get(edge.sourceId);
    const to = layout.points.get(edge.targetId);
    if (!from || !to) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance === 0) return null;
    const sourceRadius = layout.pipelineParents.has(edge.sourceId) ? SQUARE / Math.SQRT2 : NODE_RADIUS;
    const targetRadius = layout.pipelineParents.has(edge.targetId) ? SQUARE / Math.SQRT2 : NODE_RADIUS;
    const x1 = from.x + (dx / distance) * sourceRadius;
    const y1 = from.y + (dy / distance) * sourceRadius;
    const x2 = to.x - (dx / distance) * targetRadius;
    const y2 = to.y - (dy / distance) * targetRadius;
    const data = edge.wardley;
    const flow = data?.fromPort ?? data?.toPort ?? data?.flowArrow?.flow;
    const selected = selectedEdgeId === edge.id;
    const label = data?.flowArrow?.label || edge.label;
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle > 90 || angle < -90) angle += 180;
    const lx = (from.x + to.x) / 2 + (dy / distance) * 8;
    const ly = (from.y + to.y) / 2 + (-dx / distance) * 8;
    return (
      <g key={edge.id} data-testid={`wardley-link-${edge.id}`} onPointerDown={onLinkPointerDown(edge.id)} style={{ cursor: 'pointer' }}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={10} />
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={selected ? SELECTION_STROKE : STROKE}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray={edge.lineStyle === 'dotted' ? '6 6' : undefined}
          markerEnd={flow === '+>' || flow === '+<>' ? 'url(#wardley-canvas-flow-end)' : undefined}
          markerStart={flow === '+<' || flow === '+<>' ? 'url(#wardley-canvas-flow-start)' : undefined}
        />
        {label && (
          <text x={lx} y={ly} fill={TEXT} fontSize={LABEL_FONT} textAnchor="middle" dominantBaseline="middle" transform={`rotate(${angle} ${lx} ${ly})`}>
            {label}
          </text>
        )}
      </g>
    );
  };

  const renderMapNode = (node: DiagramNode) => {
    const point = layout.points.get(node.id);
    if (!point) return null;
    const { x, y } = point;
    const data = node.wardley;
    const color = highlightColor(node.id);
    if (node.role === 'anchor') {
      const lx = data?.labelOffset ? x + data.labelOffset.x : x;
      const ly = data?.labelOffset ? y + data.labelOffset.y : y - 3;
      const box = textBox(node.label, lx, ly + LABEL_FONT / 2, LABEL_FONT, 'middle');
      return (
        <g key={node.id} data-testid={`wardley-element-${node.id}`} onPointerDown={onElementPointerDown(node)} style={{ cursor: 'move' }}>
          <rect {...box} fill="transparent" />
          <text x={lx} y={ly} fill="#000" fontSize={LABEL_FONT} fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
            {node.label}
          </text>
          {color && <Highlight {...box} color={color} />}
        </g>
      );
    }
    const strategy = data?.strategy;
    const isParent = layout.pipelineParents.has(node.id);
    const parts: ReactNode[] = [];
    if (strategy) parts.push(<circle key="ring" cx={x} cy={y} r={NODE_RADIUS * 2} fill={RING[strategy]} stroke={STROKE} strokeWidth={1} />);
    if (!isParent && strategy !== 'market') parts.push(<circle key="dot" cx={x} cy={y} r={NODE_RADIUS} fill="#fff" stroke={STROKE} strokeWidth={1} />);
    if (strategy === 'market') {
      const r = NODE_RADIUS * 1.2;
      const corners: [number, number][] = [
        [x, y - r],
        [x - r * Math.cos(Math.PI / 6), y + r * Math.sin(Math.PI / 6)],
        [x + r * Math.cos(Math.PI / 6), y + r * Math.sin(Math.PI / 6)],
      ];
      corners.forEach(([x1, y1], i) => {
        const [x2, y2] = corners[(i + 1) % 3];
        parts.push(<line key={`side${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={STROKE} strokeWidth={1} />);
      });
      corners.forEach(([cx, cy], i) => parts.push(<circle key={`corner${i}`} cx={cx} cy={cy} r={NODE_RADIUS * 0.7} fill="white" stroke={STROKE} strokeWidth={2} />));
    }
    if (isParent) parts.push(<rect key="square" x={x - SQUARE / 2} y={y - SQUARE / 2} width={SQUARE} height={SQUARE} fill="#fff" stroke={STROKE} strokeWidth={1} />);
    if (data?.inertia) {
      let off = isParent ? SQUARE / 2 + 15 : NODE_RADIUS + 15;
      if (strategy) off += NODE_RADIUS + 10;
      const half = (isParent ? SQUARE : NODE_RADIUS * 2) / 2;
      parts.push(<line key="inertia" data-testid={`wardley-inertia-${node.id}`} x1={x + off} y1={y - half} x2={x + off} y2={y + half} stroke={STROKE} strokeWidth={6} />);
    }
    const lx = x + (data?.labelOffset?.x ?? (strategy ? LABEL_OFFSET + 10 : LABEL_OFFSET));
    const ly = y + (data?.labelOffset?.y ?? (strategy ? -LABEL_OFFSET - 10 : -LABEL_OFFSET));
    const reach = strategy ? NODE_RADIUS * 2 : NODE_RADIUS;
    return (
      <g key={node.id} data-testid={`wardley-element-${node.id}`} data-strategy={strategy} onPointerDown={onElementPointerDown(node)} style={{ cursor: 'move' }}>
        {/* A larger invisible target than the 6px dot, and the name too. */}
        <circle cx={x} cy={y} r={Math.max(reach, 10)} fill="transparent" />
        {parts}
        <text x={lx} y={ly} fill={TEXT} fontSize={LABEL_FONT} textAnchor="start">
          {node.label}
        </text>
        {color && <Highlight x={x - reach} y={y - reach} width={reach * 2} height={reach * 2} color={color} />}
      </g>
    );
  };

  const renderEvolve = (node: DiagramNode) => {
    const origin = layout.points.get(node.id);
    const target = node.wardley?.evolve;
    if (!origin || target === undefined) return null;
    const targetX = padding + ((target <= 1 ? target * 100 : target) / 100) * chartWidth;
    const dx = targetX - origin.x;
    const distance = Math.abs(dx);
    const shorten = NODE_RADIUS + 2;
    const x2 = distance > shorten ? targetX - (dx / distance) * shorten : targetX;
    return (
      <line
        key={`evolve-${node.id}`}
        data-testid={`wardley-evolve-${node.id}`}
        x1={origin.x}
        y1={origin.y}
        x2={x2}
        y2={origin.y}
        stroke={EVOLVE}
        strokeWidth={1}
        strokeDasharray="4 4"
        markerEnd="url(#wardley-canvas-evolve-arrow)"
        pointerEvents="none"
      />
    );
  };

  const renderOther = (node: DiagramNode) => {
    const { x, y } = node.position;
    const color = highlightColor(node.id);
    const common = { 'data-testid': `wardley-element-${node.id}`, onPointerDown: onElementPointerDown(node), style: { cursor: 'move' } };
    if (node.role === 'note') {
      const box = textBox(node.label, x, y, 11, 'start');
      return (
        <g key={node.id} {...common}>
          <rect {...box} fill="transparent" />
          <text x={x} y={y} textAnchor="start" fontSize={11} fill={TEXT} fontWeight="bold">
            {node.label}
          </text>
          {color && <Highlight {...box} color={color} />}
        </g>
      );
    }
    if (node.role === 'annotation') {
      return (
        <g key={node.id} {...common}>
          <circle cx={x} cy={y} r={10} fill="white" stroke={STROKE} strokeWidth={1.5} />
          <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={10} fill={TEXT} fontWeight="bold">
            {node.wardley?.number ?? ''}
          </text>
          {color && <Highlight x={x - 10} y={y - 10} width={20} height={20} color={color} />}
        </g>
      );
    }
    const w = 60;
    const h = 30;
    const head = 20;
    const d =
      node.role === 'accelerator'
        ? `M ${x} ${y - h / 2} L ${x + w - head} ${y - h / 2} L ${x + w - head} ${y - h / 2 - 8} L ${x + w} ${y} L ${x + w - head} ${y + h / 2 + 8} L ${x + w - head} ${y + h / 2} L ${x} ${y + h / 2} Z`
        : `M ${x + w} ${y - h / 2} L ${x + head} ${y - h / 2} L ${x + head} ${y - h / 2 - 8} L ${x} ${y} L ${x + head} ${y + h / 2 + 8} L ${x + head} ${y + h / 2} L ${x + w} ${y + h / 2} Z`;
    return (
      <g key={node.id} {...common}>
        <path d={d} fill="white" stroke={STROKE} strokeWidth={1} />
        <text x={x + w / 2} y={y + h / 2 + 15} textAnchor="middle" fontSize={10} fill={TEXT} fontWeight="bold">
          {node.label}
        </text>
        {color && <Highlight x={x} y={y - h / 2 - 8} width={w} height={h + 16} color={color} />}
      </g>
    );
  };

  const annotations = model.nodes.filter((n) => n.role === 'annotation');
  const listed = annotations
    .filter((n) => n.label)
    .map((n, index) => ({ n, index }))
    .sort((a, b) => (a.n.wardley?.number ?? 0) - (b.n.wardley?.number ?? 0) || a.index - b.index)
    .map(({ n }) => `${n.wardley?.number ?? ''}. ${n.label}`);
  const box = model.wardley?.annotationsBox;
  let annotationsBox: { x: number; y: number; width: number; height: number } | undefined;
  if (box && listed.length > 0) {
    const start: Position = {
      x: padding + ((box.evolution <= 1 ? box.evolution * 100 : box.evolution) / 100) * chartWidth,
      y: height - padding - ((box.visibility <= 1 ? box.visibility * 100 : box.visibility) / 100) * chartHeight,
    };
    const boxWidth = Math.max(...listed.map((t) => t.length * 11 * CHAR_WIDTH)) + 20 + 105;
    const boxHeight = listed.length * 16 + 20 + 11 / 2;
    annotationsBox = {
      x: Math.max(padding, Math.min(start.x, width - padding - boxWidth)),
      y: Math.max(padding, Math.min(start.y, height - padding - boxHeight)),
      width: boxWidth,
      height: boxHeight,
    };
  }

  return (
    <g className="wardley-map" data-testid="wardley-map" fontFamily='system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'>
      <defs>
        <marker id="wardley-canvas-evolve-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={EVOLVE} />
        </marker>
        <marker id="wardley-canvas-flow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={STROKE} />
        </marker>
        <marker id="wardley-canvas-flow-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 10 0 L 0 5 L 10 10 z" fill={STROKE} />
        </marker>
      </defs>
      <g pointerEvents="none">
        {model.title && (
          <text x={width / 2} y={padding / 2} fill={TEXT} fontSize={AXIS_FONT * 1.05} fontWeight="bold" textAnchor="middle" dominantBaseline="middle">
            {model.title}
          </text>
        )}
        <line x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} stroke={STROKE} strokeWidth={1} />
        <line x1={padding} x2={padding} y1={padding} y2={height - padding} stroke={STROKE} strokeWidth={1} />
        <text x={padding + chartWidth / 2} y={height - padding / 4} fill={TEXT} fontSize={AXIS_FONT} fontWeight="bold" textAnchor="middle">
          Evolution
        </text>
        <text
          x={padding / 3}
          y={padding + chartHeight / 2}
          fill={TEXT}
          fontSize={AXIS_FONT}
          fontWeight="bold"
          textAnchor="middle"
          transform={`rotate(-90 ${padding / 3} ${padding + chartHeight / 2})`}
        >
          Visibility
        </text>
        {layout.stages.map((stage, index) => {
          const startX = padding + stage.start * chartWidth;
          const endX = padding + stage.end * chartWidth;
          return (
            <g key={`stage-${index}`}>
              {index > 0 && <line x1={startX} x2={startX} y1={padding} y2={height - padding} stroke="#000" strokeWidth={1} strokeDasharray="5 5" opacity={0.8} />}
              <text x={(startX + endX) / 2} y={height - padding / 1.5} fill={TEXT} fontSize={AXIS_FONT - 2} textAnchor="middle">
                {stage.label}
              </text>
            </g>
          );
        })}
        {layout.pipelines.map((pipeline) => {
          const byId = new Map(model.nodes.map((n) => [n.id, n]));
          const points = pipeline.children
            .map((id) => byId.get(id))
            .filter((n): n is DiagramNode => n !== undefined)
            .map((n) => n.position)
            .sort((a, b) => a.x - b.x);
          return (
            <g key={pipeline.id} data-testid={`wardley-pipeline-${pipeline.id}`}>
              {points.slice(0, -1).map((p, i) => (
                <line key={i} x1={p.x} y1={p.y} x2={points[i + 1].x} y2={points[i + 1].y} stroke={STROKE} strokeWidth={1} strokeDasharray="4 4" />
              ))}
              <rect x={pipeline.box.x} y={pipeline.box.y} width={pipeline.box.width} height={pipeline.box.height} fill="none" stroke={STROKE} strokeWidth={1.5} rx={4} />
            </g>
          );
        })}
      </g>
      <g>{model.edges.map(renderLink)}</g>
      <g>{model.nodes.filter(isWardleyMapNode).map(renderEvolve)}</g>
      <g>{model.nodes.filter(isWardleyMapNode).map(renderMapNode)}</g>
      <g>{annotations.map(renderOther)}</g>
      {annotationsBox && (
        <g pointerEvents="none" data-testid="wardley-annotations-box">
          <rect {...annotationsBox} fill="white" stroke={STROKE} strokeWidth={1.5} rx={4} />
          {listed.map((text, index) => (
            <text key={index} x={annotationsBox.x + 10} y={annotationsBox.y + 10 + (index + 1) * 16} fontSize={11} fill={TEXT} textAnchor="start" dominantBaseline="middle">
              {text}
            </text>
          ))}
        </g>
      )}
      <g>{model.nodes.filter((n) => n.role === 'note' || n.role === 'accelerator' || n.role === 'deaccelerator').map(renderOther)}</g>
    </g>
  );
}
