import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addContainer,
  addEdge,
  addNode,
  assignNodeToContainer,
  moveContainer,
  removeContainer,
  removeNode,
  removeNodeFromContainer,
  resizeContainer,
  updateContainerLabel,
  updateEdgeLabel,
  updateNodeLabel,
  splitLabelLines,
  clipEdgeEndpoint,
  sanitizeSvgFragment,
  type DiagramContainer,
  type DiagramModel,
  type DiagramNode,
  type NodeShape,
} from '@canvas/diagram-core';
import { getAddableShapes, nodeSize, renderNodeShape } from './shapes';
import { ConfirmDialog } from './ConfirmDialog';
import { api } from '../app/api';
import { Icon } from '../ui/Icon';

/** Compact glyphs for the shape grid — each button still carries an aria-label and title, so the
 *  glyph is decorative and the control keeps its accessible name. */
const SHAPE_GLYPHS: Partial<Record<NodeShape, string>> = {
  rectangle: '▭',
  'rounded-rectangle': '▢',
  circle: '○',
  diamond: '◇',
  stadium: '⬭',
  subroutine: '⊟',
  'double-circle': '◎',
  hexagon: '⬡',
  parallelogram: '▱',
  trapezoid: '⏢',
  asymmetric: '⌂',
};

// Grouping B: default visual treatment per lineStyle, mirroring svg-renderer.ts exactly so the
// canvas and export never disagree about what a dotted/thick edge looks like (SC-004).
const DEFAULT_DOTTED_DASHARRAY = '4 2';
const DEFAULT_THICK_STROKE_WIDTH = 3;

export interface CanvasProps {
  model: DiagramModel;
  onChange: (model: DiagramModel) => void;
  /** The diagram type's DSL family (e.g. `'flowchart'`, `'erd'`) — scopes which shapes the "Add
   *  Shape" toolbar offers (feature 009). Several diagram types share `dslFamily: 'flowchart'`
   *  without `diagramTypeId === 'flowchart'`, so this must not be substituted with the type id. */
  dslFamily: string;
  /**
   * Where to render the diagram-tools toolbar. The editor passes its left palette rail so the
   * tools sit with the shape palette (feature 005), while the toolbar's `role` and accessible
   * name — and all of its testids — travel with it unchanged. Portalling rather than lifting
   * keeps every piece of canvas interaction state (selection, connect mode, inline editing)
   * where it already lives. Omit it and the toolbar renders in place, as before.
   */
  toolbarContainer?: HTMLElement | null;
}

/** Minimum a container may be dragged down to, so it never becomes un-grabbable. */
const MIN_CONTAINER_SIZE = { width: 80, height: 60 };

// Grouping F (docs/flowchart-completeness-brief.md): splits identically to svg-renderer.ts's own
// `splitLabelLines` (imported, not reimplemented) so the canvas and export never disagree about
// where a label breaks (SC-004). `centered` mirrors `dominantBaseline="middle"`'s effect for the
// single-line case, vertically centering the whole stacked block instead of just the first line.
function renderLabelLines(
  x: number,
  y: number,
  label: string,
  fontSize: number,
  centered: boolean,
): JSX.Element {
  const lines = splitLabelLines(label);
  if (lines.length === 1) {
    return (
      <text x={x} y={y} textAnchor="middle" dominantBaseline={centered ? 'middle' : undefined} fontSize={fontSize}>
        {label}
      </text>
    );
  }
  const lineHeightEm = 1.2;
  const firstDy = centered ? (-(lines.length - 1) * lineHeightEm) / 2 : 0;
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={fontSize}>
      {lines.map((line, i) => (
        <tspan key={i} x={x} dy={`${i === 0 ? firstDy : lineHeightEm}em`}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/**
 * canvas-8n7: renders resolved icon markup via an `<image>` element's `data:` URI rather than
 * `dangerouslySetInnerHTML`, so it is never inserted into the live DOM as executable markup in
 * the first place — browsers do not execute `<script>`/event-handler content inside an SVG
 * loaded as an image resource, a stronger guarantee than string sanitization alone (which stays
 * on as defense in depth, not as the only safeguard). Wraps the bare `<g>...</g>` fragment in a
 * standalone `<svg>` matching the library's normalized 48x48 icon viewBox (see
 * generate-azure-icons.mjs), since a data URI must be a complete, self-contained document.
 */
function iconMarkupToDataUri(markup: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${markup}</svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

function containerBounds(container: DiagramContainer) {
  const size = container.size ?? { width: 300, height: 200 };
  return {
    left: container.position.x,
    top: container.position.y,
    right: container.position.x + size.width,
    bottom: container.position.y + size.height,
  };
}

/** Which container, if any, a dropped shape lands in — decided by the shape's centre point.
 *  Geometry decides membership only at the moment of a drop; `containerId` is authoritative
 *  afterwards, so resizing a container never ejects anything (research §3). */
function containerAtPoint(model: DiagramModel, point: { x: number; y: number }): string | undefined {
  // Last match wins, so a container drawn later (visually on top) takes precedence.
  let found: string | undefined;
  for (const container of model.containers) {
    const b = containerBounds(container);
    if (point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom) {
      found = container.id;
    }
  }
  return found;
}

/**
 * Interactive diagram canvas (User Story 1, FR-001): add/move/connect/group shapes and text
 * labels via direct manipulation. Renders the same DiagramModel that packages/diagram-core
 * parses/serializes, so every edit here is reflected in the Mermaid DSL by useDslSync.
 */
export function Canvas({ model, onChange, dslFamily, toolbarContainer }: CanvasProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [connectMode, setConnectMode] = useState(false);
  const [connectSourceId, setConnectSourceId] = useState<string | null>(null);
  // canvas-7rr: chosen once per connection, applied when the second shape is clicked. 'reversed'
  // needs no DiagramEdge.arrow value — it is just sourceId/targetId swapped at that point.
  const [connectArrowStyle, setConnectArrowStyle] = useState<'forward' | 'reversed' | 'both' | 'none'>('forward');
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [editingContainerId, setEditingContainerId] = useState<string | null>(null);
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Which element the pointer is over. Paired with selection below so the edit affordance is
  // reachable by keyboard too — hover alone would be unusable without a pointer (FR-017).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // `kind` distinguishes the three drags that share the pointer handlers: moving a shape, moving
  // a container (which carries its members), and resizing a container.
  const dragState = useRef<
    { kind: 'node' | 'container'; id: string; offsetX: number; offsetY: number }
    | { kind: 'resize'; id: string; originX: number; originY: number }
    | null
  >(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // canvas-8n7: a node only stores an icon *reference* (Constitution V), not its artwork, so the
  // canvas must resolve refs to real SVG markup at render time — mirroring how svg-renderer.ts's
  // export path already does via its own resolveIcon callback (SC-004). Cached per library+
  // version+icon (keyed `${libraryId}@${libraryVersion}@${iconId}`) so placing many icons from
  // the same library costs one fetch, not one per node.
  //
  // "Do I still need to fetch this?" is answered by checking the cache itself (`iconArtwork`,
  // in the dependency array), not a separate ref marking a library as "already requested" —
  // that second form has a real bug under StrictMode's dev-only mount→cleanup→remount: the ref
  // would get marked *before* the request resolves, so when the first (simulated) instance's
  // cleanup sets its own `cancelled` flag, the second (surviving) instance sees the library as
  // already handled and never fetches at all — the original response arrives but is discarded,
  // and the icon never renders. Gating on the cache instead means the surviving instance always
  // sees an empty cache and issues its own fetch, since neither instance's ref-write can
  // suppress the other's decision to fetch.
  const [iconArtwork, setIconArtwork] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const toFetch = new Map<string, { libraryId: string; libraryVersion: string }>();
    for (const node of model.nodes) {
      if (node.shape === 'icon' && node.icon) {
        const libraryKey = `${node.icon.libraryId}@${node.icon.libraryVersion}`;
        const cacheKey = `${libraryKey}@${node.icon.iconId}`;
        if (!iconArtwork.has(cacheKey)) {
          toFetch.set(libraryKey, { libraryId: node.icon.libraryId, libraryVersion: node.icon.libraryVersion });
        }
      }
    }
    if (toFetch.size === 0) return;

    let cancelled = false;
    Promise.all(
      Array.from(toFetch.values()).map(({ libraryId, libraryVersion }) =>
        api
          .getLibraryIcons(libraryId, libraryVersion)
          .then(({ icons }) => ({ libraryId, libraryVersion, icons }))
          .catch(() => ({ libraryId, libraryVersion, icons: [] })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setIconArtwork((prev) => {
        const next = new Map(prev);
        for (const { libraryId, libraryVersion, icons } of results) {
          // Defense in depth: assetRef is sanitized at admin-only library-ingestion time
          // (loadLibrary), but this re-applies the same sanitizer at the point of rendering,
          // right before dangerouslySetInnerHTML, rather than trusting that ingestion-time pass
          // is still intact by the time markup has traveled through the DB and a network fetch.
          for (const icon of icons) {
            next.set(`${libraryId}@${libraryVersion}@${icon.id}`, sanitizeSvgFragment(icon.assetRef));
          }
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [model.nodes, iconArtwork]);

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
        const reversed = connectArrowStyle === 'reversed';
        onChange(
          addEdge(model, {
            sourceId: reversed ? node.id : connectSourceId,
            targetId: reversed ? connectSourceId : node.id,
            arrow: connectArrowStyle === 'both' || connectArrowStyle === 'none' ? connectArrowStyle : undefined,
          }),
        );
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
    setSelectedContainerId(null);

    const point = toClientPoint(event);
    dragState.current = {
      kind: 'node',
      id: node.id,
      offsetX: point.x - node.position.x,
      offsetY: point.y - node.position.y,
    };
  };

  const handleAddContainer = () => {
    onChange(addContainer(model, {}));
  };

  const handleContainerPointerDown = (container: DiagramContainer) => (event: React.PointerEvent) => {
    // Containers sit behind shapes; a pointer-down that reached here is on the container itself.
    event.stopPropagation();
    if (connectMode) return;
    setSelectedContainerId(container.id);
    setSelectedIds(new Set());

    const point = toClientPoint(event);
    dragState.current = {
      kind: 'container',
      id: container.id,
      offsetX: point.x - container.position.x,
      offsetY: point.y - container.position.y,
    };
  };

  const handleResizePointerDown = (container: DiagramContainer) => (event: React.PointerEvent) => {
    event.stopPropagation();
    dragState.current = {
      kind: 'resize',
      id: container.id,
      originX: container.position.x,
      originY: container.position.y,
    };
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag) return;
    const point = toClientPoint(event);

    if (drag.kind === 'node') {
      updateNode(drag.id, { position: { x: point.x - drag.offsetX, y: point.y - drag.offsetY } });
      return;
    }

    if (drag.kind === 'resize') {
      // The top-left stays put, so the new size is simply the pointer's offset from it.
      onChange(
        resizeContainer(model, drag.id, {
          width: Math.max(MIN_CONTAINER_SIZE.width, point.x - drag.originX),
          height: Math.max(MIN_CONTAINER_SIZE.height, point.y - drag.originY),
        }),
      );
      return;
    }

    // moveContainer carries members and nested containers with it.
    onChange(moveContainer(model, drag.id, { x: point.x - drag.offsetX, y: point.y - drag.offsetY }));
  };

  const handlePointerUp = () => {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag || drag.kind !== 'node') return;

    // Membership is resolved once, on drop, from the shape's centre (FR-011, research §3).
    const node = model.nodes.find((n) => n.id === drag.id);
    if (!node) return;
    const size = nodeSize(node);
    const centre = { x: node.position.x + size.width / 2, y: node.position.y + size.height / 2 };
    const target = containerAtPoint(model, centre);

    if (target && node.containerId !== target) {
      onChange(assignNodeToContainer(model, node.id, target));
    } else if (!target && node.containerId) {
      onChange(removeNodeFromContainer(model, node.id));
    }
  };

  /** A small pencil control that opens the label editor that already exists. Revealed on hover
   *  AND on selection/focus — an affordance only reachable by pointer would fail the
   *  accessibility gate (research §11). */
  const renderEditAffordance = (id: string, x: number, y: number, onActivate: () => void, label: string) => (
    <foreignObject x={x} y={y} width={22} height={22}>
      <button
        type="button"
        className="canvas-edit-affordance"
        data-testid={`edit-label-${id}`}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Icon name="pencil" size={12} />
      </button>
    </foreignObject>
  );

  const commitContainerLabel = (containerId: string, label: string) => {
    onChange(updateContainerLabel(model, containerId, label || 'Container'));
    setEditingContainerId(null);
  };

  const commitLabel = (nodeId: string, label: string) => {
    onChange(updateNodeLabel(model, nodeId, label || 'Untitled'));
    setEditingNodeId(null);
  };

  const commitEdgeLabel = (edgeId: string, label: string) => {
    onChange(updateEdgeLabel(model, edgeId, label));
    setEditingEdgeId(null);
  };

  /** Wraps the selected shapes in a container. Now routed through the shared operations rather
   *  than building the container inline, so manual, DSL, and future AI edits share one path. */
  const groupSelected = () => {
    if (selectedIds.size < 2) return;
    const selectedNodes = model.nodes.filter((n) => selectedIds.has(n.id));
    const minX = Math.min(...selectedNodes.map((n) => n.position.x)) - 20;
    const minY = Math.min(...selectedNodes.map((n) => n.position.y)) - 20;
    const maxX = Math.max(...selectedNodes.map((n) => n.position.x + nodeSize(n).width)) + 20;
    const maxY = Math.max(...selectedNodes.map((n) => n.position.y + nodeSize(n).height)) + 20;

    let next = addContainer(model, {
      position: { x: minX, y: minY },
      size: { width: maxX - minX, height: maxY - minY },
    });
    const containerId = next.containers[next.containers.length - 1].id;
    for (const nodeId of selectedIds) {
      next = assignNodeToContainer(next, nodeId, containerId);
    }
    onChange(next);
    setSelectedIds(new Set());
  };

  const requestDeleteSelected = () => {
    if (selectedIds.size === 0 && !selectedContainerId) return;
    setShowDeleteConfirm(true);
  };

  const confirmDeleteSelected = () => {
    let next = model;
    for (const id of selectedIds) {
      next = removeNode(next, id);
    }
    // Deleting a container releases its shapes — it never deletes them (FR-013).
    if (selectedContainerId) {
      next = removeContainer(next, selectedContainerId);
    }
    onChange(next);
    setSelectedIds(new Set());
    setSelectedContainerId(null);
    setShowDeleteConfirm(false);
  };

  const deleteConfirmMessage = selectedContainerId
    ? 'Delete this container? The shapes inside it will be kept on the canvas.'
    : `Delete ${selectedIds.size} selected shape${selectedIds.size === 1 ? '' : 's'}? This cannot be undone.`;

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
          {getAddableShapes(dslFamily).map(({ shape, label }) => (
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
          {/* canvas-7rr: chosen before clicking the second shape — the only way to draw a
              bidirectional or no-arrowhead connector interactively used to be two separate edges
              faking it (A->B and B->A). */}
          {connectMode && (
            <label className="field__label" htmlFor="connect-arrow-style">
              Direction
              <select
                id="connect-arrow-style"
                data-testid="connect-arrow-style"
                value={connectArrowStyle}
                onChange={(e) => setConnectArrowStyle(e.target.value as typeof connectArrowStyle)}
              >
                <option value="forward">Forward (A → B)</option>
                <option value="reversed">Reversed (B → A)</option>
                <option value="both">Bidirectional (A ↔ B)</option>
                <option value="none">No arrowhead (A — B)</option>
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="add-container"
            onClick={handleAddContainer}
          >
            <Icon name="group" />
            Add Container
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="group-selected"
            disabled={selectedIds.size < 2}
            onClick={groupSelected}
          >
            <Icon name="group" />
            Group into Container
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="delete-selected"
            disabled={selectedIds.size === 0 && !selectedContainerId}
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
          message={deleteConfirmMessage}
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
          if (event.target === event.currentTarget) {
            setSelectedIds(new Set());
            setSelectedContainerId(null);
          }
        }}
      >
        {model.containers.map((container) => {
          const size = container.size ?? { width: 300, height: 200 };
          const isSelected = selectedContainerId === container.id;
          return (
            <g
              key={container.id}
              data-testid={`container-${container.id}`}
              onPointerDown={handleContainerPointerDown(container)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingContainerId(container.id);
              }}
              style={{ cursor: 'move' }}
            >
              {/* Appearance is deliberately unchanged from what the export renderer draws — this
                  feature adds interaction, not styling (research §7). Only the selection stroke
                  differs, and it is screen-only. */}
              <rect
                x={container.position.x}
                y={container.position.y}
                width={size.width}
                height={size.height}
                fill="transparent"
                stroke={isSelected ? '#2563eb' : '#888'}
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray="6,4"
              />
              {editingContainerId !== container.id && (
                <text x={container.position.x + 8} y={container.position.y + 16} fontSize={12}>
                  {container.label}
                </text>
              )}
              {editingContainerId === container.id && (
                <foreignObject x={container.position.x + 4} y={container.position.y + 4} width={160} height={24}>
                  <input
                    data-testid={`container-label-input-${container.id}`}
                    autoFocus
                    defaultValue={container.label}
                    style={{ width: '100%', boxSizing: 'border-box' }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitContainerLabel(container.id, (e.target as HTMLInputElement).value);
                      if (e.key === 'Escape') setEditingContainerId(null);
                    }}
                    onBlur={(e) => commitContainerLabel(container.id, e.target.value)}
                  />
                </foreignObject>
              )}
              {/* Resize handle renders only for the selected container, so the steady-state
                  element count is unchanged and the drag performance gate is unaffected. */}
              {isSelected && (
                <rect
                  data-testid={`container-resize-${container.id}`}
                  x={container.position.x + size.width - 5}
                  y={container.position.y + size.height - 5}
                  width={10}
                  height={10}
                  fill="#2563eb"
                  style={{ cursor: 'nwse-resize' }}
                  onPointerDown={handleResizePointerDown(container)}
                />
              )}
            </g>
          );
        })}

        {model.edges.map((edge) => {
          const source = model.nodes.find((n) => n.id === edge.sourceId);
          const target = model.nodes.find((n) => n.id === edge.targetId);
          if (!source || !target) return null;
          const from = { x: source.position.x + nodeSize(source).width / 2, y: source.position.y + nodeSize(source).height / 2 };
          const to = { x: target.position.x + nodeSize(target).width / 2, y: target.position.y + nodeSize(target).height / 2 };
          const midX = (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          // canvas-1rq: clip each endpoint to its own node's boundary — otherwise the arrowhead
          // (and the line segment inside each node) is hidden underneath the node's opaque fill,
          // since nodes render on top of edges. Must match svg-renderer.ts exactly (SC-004).
          const clippedFrom = clipEdgeEndpoint(from, nodeSize(source), source.shape, to.x, to.y);
          const clippedTo = clipEdgeEndpoint(to, nodeSize(target), target.shape, from.x, from.y);
          const isEditingThisEdge = editingEdgeId === edge.id;
          return (
            <g
              key={edge.id}
              data-testid={`edge-${edge.id}`}
              onPointerEnter={() => setHoveredId(edge.id)}
              onPointerLeave={() => setHoveredId((current) => (current === edge.id ? null : current))}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingEdgeId(edge.id);
              }}
            >
              <line
                x1={clippedFrom.x}
                y1={clippedFrom.y}
                x2={clippedTo.x}
                y2={clippedTo.y}
                stroke={edge.lineStyle === 'invisible' ? 'none' : (edge.style?.strokeColor ?? '#333')}
                strokeWidth={edge.style?.strokeWidth ?? (edge.lineStyle === 'thick' ? DEFAULT_THICK_STROKE_WIDTH : undefined)}
                strokeDasharray={edge.style?.strokeDasharray ?? (edge.lineStyle === 'dotted' ? DEFAULT_DOTTED_DASHARRAY : undefined)}
                markerStart={edge.lineStyle !== 'invisible' && edge.arrow === 'both' ? 'url(#arrow)' : undefined}
                markerEnd={edge.lineStyle === 'invisible' || edge.arrow === 'none' ? undefined : 'url(#arrow)'}
              />
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
              {!isEditingThisEdge && edge.label && renderLabelLines(midX, midY - 4, edge.label, 12, false)}
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
              {!isEditingThisEdge &&
                !connectMode &&
                hoveredId === edge.id &&
                renderEditAffordance(
                  edge.id,
                  midX + 8,
                  midY - 26,
                  () => setEditingEdgeId(edge.id),
                  `Edit label for connector ${edge.id}`,
                )}
            </g>
          );
        })}

        <defs>
          {/* auto-start-reverse: identical to "auto" as a marker-end; as a marker-start it points
              the other way, so this one definition serves both ends of a bidirectional edge. */}
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto-start-reverse">
            <path d="M0,0 L0,6 L9,3 z" fill="#333" />
          </marker>
        </defs>

        {model.nodes.map((node) => {
          const size = nodeSize(node);
          // canvas-8n7: mirrors svg-renderer.ts's renderNode icon branch exactly (same 0.6 scale
          // factor, same -8 vertical nudge, same 48x48 normalized icon viewBox, same smaller
          // below-icon caption instead of a centered label) so canvas and export agree (SC-004).
          const iconMarkup =
            node.shape === 'icon' && node.icon
              ? iconArtwork.get(`${node.icon.libraryId}@${node.icon.libraryVersion}@${node.icon.iconId}`)
              : undefined;
          return (
            <g
              key={node.id}
              data-testid={`node-${node.id}`}
              onPointerDown={handleNodePointerDown(node)}
              onPointerEnter={() => setHoveredId(node.id)}
              onPointerLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingNodeId(node.id);
              }}
              style={{ cursor: connectMode ? 'crosshair' : 'move' }}
            >
              {renderNodeShape(node, selectedIds.has(node.id))}
              {iconMarkup &&
                (() => {
                  const iconSize = Math.min(size.width, size.height) * 0.6;
                  const iconX = node.position.x + (size.width - iconSize) / 2;
                  const iconY = node.position.y + (size.height - iconSize) / 2 - 8;
                  return <image x={iconX} y={iconY} width={iconSize} height={iconSize} href={iconMarkupToDataUri(iconMarkup)} />;
                })()}
              {editingNodeId !== node.id &&
                (iconMarkup
                  ? renderLabelLines(node.position.x + size.width / 2, node.position.y + size.height - 10, node.label, 12, false)
                  : renderLabelLines(node.position.x + size.width / 2, node.position.y + size.height / 2, node.label, 14, true))}
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
              {editingNodeId !== node.id &&
                !connectMode &&
                (hoveredId === node.id || selectedIds.has(node.id)) &&
                renderEditAffordance(
                  node.id,
                  node.position.x + size.width - 24,
                  node.position.y + 2,
                  () => setEditingNodeId(node.id),
                  `Edit label for ${node.label}`,
                )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
