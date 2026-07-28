import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addEdge,
  addNode,
  removeNode,
  updateEdgeLabel,
  updateNodeLabel,
  type DiagramModel,
  type DiagramNode,
  type NodeShape,
} from '@canvas/diagram-core';
import { ADDABLE_SHAPES, nodeSize, renderNodeShape } from './shapes';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from '../ui/Icon';

/** Compact glyphs for the shape grid — each button still carries an aria-label and title, so the
 *  glyph is decorative and the control keeps its accessible name. */
const SHAPE_GLYPHS: Partial<Record<NodeShape, string>> = {
  rectangle: '▭',
  'rounded-rectangle': '▢',
  circle: '○',
  diamond: '◇',
};

export interface CanvasProps {
  model: DiagramModel;
  onChange: (model: DiagramModel) => void;
  /**
   * Where to render the diagram-tools toolbar. The editor passes its left palette rail so the
   * tools sit with the shape palette (feature 005), while the toolbar's `role` and accessible
   * name — and all of its testids — travel with it unchanged. Portalling rather than lifting
   * keeps every piece of canvas interaction state (selection, connect mode, inline editing)
   * where it already lives. Omit it and the toolbar renders in place, as before.
   */
  toolbarContainer?: HTMLElement | null;
}

let containerIdCounter = 0;
function nextContainerId(): string {
  containerIdCounter += 1;
  return `grp${containerIdCounter}`;
}

/**
 * Interactive diagram canvas (User Story 1, FR-001): add/move/connect/group shapes and text
 * labels via direct manipulation. Renders the same DiagramModel that packages/diagram-core
 * parses/serializes, so every edit here is reflected in the Mermaid DSL by useDslSync.
 */
export function Canvas({ model, onChange, toolbarContainer }: CanvasProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [connectMode, setConnectMode] = useState(false);
  const [connectSourceId, setConnectSourceId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const dragState = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const updateNode = useCallback(
    (id: string, patch: Partial<DiagramNode>) => {
      onChange({
        ...model,
        nodes: model.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      });
    },
    [model, onChange],
  );

  const handleAddShape = (shape: NodeShape) => {
    onChange(addNode(model, { shape }));
  };

  const toClientPoint = (event: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handleNodePointerDown = (node: DiagramNode) => (event: React.PointerEvent) => {
    event.stopPropagation();
    if (connectMode) {
      if (!connectSourceId) {
        setConnectSourceId(node.id);
      } else if (connectSourceId !== node.id) {
        onChange(addEdge(model, { sourceId: connectSourceId, targetId: node.id }));
        setConnectSourceId(null);
        setConnectMode(false);
      }
      return;
    }

    if (event.shiftKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      return;
    }
    setSelectedIds(new Set([node.id]));

    const point = toClientPoint(event);
    dragState.current = { id: node.id, offsetX: point.x - node.position.x, offsetY: point.y - node.position.y };
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!dragState.current) return;
    const point = toClientPoint(event);
    updateNode(dragState.current.id, {
      position: { x: point.x - dragState.current.offsetX, y: point.y - dragState.current.offsetY },
    });
  };

  const handlePointerUp = () => {
    dragState.current = null;
  };

  const commitLabel = (nodeId: string, label: string) => {
    onChange(updateNodeLabel(model, nodeId, label || 'Untitled'));
    setEditingNodeId(null);
  };

  const commitEdgeLabel = (edgeId: string, label: string) => {
    onChange(updateEdgeLabel(model, edgeId, label));
    setEditingEdgeId(null);
  };

  const groupSelected = () => {
    if (selectedIds.size < 2) return;
    const selectedNodes = model.nodes.filter((n) => selectedIds.has(n.id));
    const minX = Math.min(...selectedNodes.map((n) => n.position.x)) - 20;
    const minY = Math.min(...selectedNodes.map((n) => n.position.y)) - 20;
    const maxX = Math.max(...selectedNodes.map((n) => n.position.x + nodeSize(n).width)) + 20;
    const maxY = Math.max(...selectedNodes.map((n) => n.position.y + nodeSize(n).height)) + 20;
    const containerId = nextContainerId();

    onChange({
      ...model,
      containers: [
        ...model.containers,
        {
          id: containerId,
          label: 'Group',
          position: { x: minX, y: minY },
          size: { width: maxX - minX, height: maxY - minY },
        },
      ],
      nodes: model.nodes.map((n) => (selectedIds.has(n.id) ? { ...n, containerId } : n)),
    });
    setSelectedIds(new Set());
  };

  const requestDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    setShowDeleteConfirm(true);
  };

  const confirmDeleteSelected = () => {
    let next = model;
    for (const id of selectedIds) {
      next = removeNode(next, id);
    }
    onChange(next);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  };

  const cancelDeleteSelected = () => setShowDeleteConfirm(false);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't intercept Delete/Backspace while a label is being typed into.
    if (editingNodeId || editingEdgeId) return;
    const tag = (event.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.size > 0) {
      event.preventDefault();
      requestDeleteSelected();
    }
  };

  const toolbar = (
    <div role="toolbar" aria-label="Diagram tools">
      <div className="rail-section">
        <p className="section-label rail-section__label">Shapes</p>
        <div className="shape-grid">
          {ADDABLE_SHAPES.map(({ shape, label }) => (
            <button
              key={shape}
              type="button"
              className="btn btn--secondary"
              data-testid={`add-shape-${shape}`}
              title={`Add ${label}`}
              aria-label={`Add ${label}`}
              onClick={() => handleAddShape(shape)}
            >
              {SHAPE_GLYPHS[shape] ?? label}
            </button>
          ))}
        </div>
      </div>

      <div className="rail-section">
        <p className="section-label rail-section__label">Tools</p>
        <div className="tool-list">
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="connect-mode-toggle"
            aria-pressed={connectMode}
            onClick={() => {
              setConnectMode((v) => !v);
              setConnectSourceId(null);
            }}
          >
            <Icon name="arrow-right" />
            {connectMode ? 'Cancel Connect' : 'Connect'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="group-selected"
            disabled={selectedIds.size < 2}
            onClick={groupSelected}
          >
            <Icon name="group" />
            Group Selected
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="delete-selected"
            disabled={selectedIds.size === 0}
            onClick={requestDeleteSelected}
          >
            <Icon name="trash" />
            Delete Selected
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="canvas-root" tabIndex={0} onKeyDown={handleKeyDown} data-testid="canvas-root">
      {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbar}

      {showDeleteConfirm && (
        <ConfirmDialog
          message={`Delete ${selectedIds.size} selected shape${selectedIds.size === 1 ? '' : 's'}? This cannot be undone.`}
          onConfirm={confirmDeleteSelected}
          onCancel={cancelDeleteSelected}
        />
      )}

      <svg
        ref={svgRef}
        data-testid="diagram-canvas"
        className="canvas-svg"
        width={800}
        height={500}
        // The border moved to the surrounding container so the SVG can fill it and let the
        // dot-grid background show through; `touchAction` stays inline because it is behaviour,
        // not styling. Width/height remain as the intrinsic size — CSS stretches it, and the
        // origin stays at the container's top-left so drag coordinate maths is unchanged.
        style={{ touchAction: 'none' }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={(event) => {
          // Only deselect on a genuine click on the canvas background — not one that bubbled up
          // from a node/edge click, which already set the selection this same interaction.
          if (event.target === event.currentTarget) setSelectedIds(new Set());
        }}
      >
        {model.containers.map((container) => (
          <g key={container.id} data-testid={`container-${container.id}`}>
            <rect
              x={container.position.x}
              y={container.position.y}
              width={container.size?.width ?? 300}
              height={container.size?.height ?? 200}
              fill="none"
              stroke="#888"
              strokeDasharray="6,4"
            />
            <text x={container.position.x + 8} y={container.position.y + 16} fontSize={12}>
              {container.label}
            </text>
          </g>
        ))}

        {model.edges.map((edge) => {
          const source = model.nodes.find((n) => n.id === edge.sourceId);
          const target = model.nodes.find((n) => n.id === edge.targetId);
          if (!source || !target) return null;
          const from = { x: source.position.x + nodeSize(source).width / 2, y: source.position.y + nodeSize(source).height / 2 };
          const to = { x: target.position.x + nodeSize(target).width / 2, y: target.position.y + nodeSize(target).height / 2 };
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          const isEditingThisEdge = editingEdgeId === edge.id;
          return (
            <g
              key={edge.id}
              data-testid={`edge-${edge.id}`}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingEdgeId(edge.id);
              }}
            >
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#333" markerEnd="url(#arrow)" />
              {/* Padded invisible hit-target rect, not a thin line: a horizontal or vertical
                  connector's own geometry has a zero-height/width bounding box, which is not a
                  reliable click (or double-click) target for a user or for automated testing. */}
              <rect
                x={Math.min(from.x, to.x) - 10}
                y={Math.min(from.y, to.y) - 10}
                width={Math.max(Math.abs(to.x - from.x), 1) + 20}
                height={Math.max(Math.abs(to.y - from.y), 1) + 20}
                fill="transparent"
              />
              {!isEditingThisEdge && edge.label && (
                <text x={midX} y={midY - 4} fontSize={12} textAnchor="middle">
                  {edge.label}
                </text>
              )}
              {isEditingThisEdge && (
                <foreignObject x={midX - 60} y={midY - 12} width={120} height={24}>
                  <input
                    data-testid={`edge-label-input-${edge.id}`}
                    autoFocus
                    defaultValue={edge.label ?? ''}
                    style={{ width: '100%', boxSizing: 'border-box', textAlign: 'center' }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdgeLabel(edge.id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') setEditingEdgeId(null);
                    }}
                    onBlur={(e) => commitEdgeLabel(edge.id, e.target.value)}
                  />
                </foreignObject>
              )}
            </g>
          );
        })}

        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
            <path d="M0,0 L0,6 L9,3 z" fill="#333" />
          </marker>
        </defs>

        {model.nodes.map((node) => {
          const size = nodeSize(node);
          return (
            <g
              key={node.id}
              data-testid={`node-${node.id}`}
              onPointerDown={handleNodePointerDown(node)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingNodeId(node.id);
              }}
              style={{ cursor: connectMode ? 'crosshair' : 'move' }}
            >
              {renderNodeShape(node, selectedIds.has(node.id))}
              {editingNodeId !== node.id && (
                <text
                  x={node.position.x + size.width / 2}
                  y={node.position.y + size.height / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={14}
                >
                  {node.label}
                </text>
              )}
              {editingNodeId === node.id && (
                <foreignObject x={node.position.x} y={node.position.y} width={size.width} height={size.height}>
                  <input
                    data-testid={`node-label-input-${node.id}`}
                    autoFocus
                    defaultValue={node.label}
                    style={{ width: '100%', height: '100%', textAlign: 'center', boxSizing: 'border-box' }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitLabel(node.id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') setEditingNodeId(null);
                    }}
                    onBlur={(e) => commitLabel(node.id, e.target.value)}
                  />
                </foreignObject>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
