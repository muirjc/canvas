import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addContainer,
  addEdge,
  addNode,
  assignNodeToContainer,
  moveContainer,
  removeContainer,
  removeEdge,
  removeNode,
  removeNodeFromContainer,
  resizeContainer,
  updateContainerLabel,
  updateEdgeLabel,
  updateEdgeStyle,
  updateNodeLabel,
  updateNodeStyle,
  updateEntityAttributes,
  updateClassMembers,
  splitLabelLines,
  clipEdgeEndpoint,
  clipToAnchorSide,
  architectureEndpointBox,
  computeBounds,
  computeSequenceLayout,
  SELF_MESSAGE_LOOP_WIDTH,
  containerRoleStyle,
  LABELED_CONTROL_FLOW_ROLES,
  CONTROL_FLOW_STROKE,
  CONTROL_FLOW_DASHARRAY,
  CONTROL_FLOW_TAB_FILL,
  sanitizeSvgFragment,
  autoLayout,
  iconNodeLayout,
  tableNodeLayout,
  cardinalityGlyphs,
  umlEndpointGlyph,
  umlEndpointMarkers,
  umlCardinalityLabelPosition,
  DEFAULT_ER_SOURCE_CARDINALITY,
  DEFAULT_ER_TARGET_CARDINALITY,
  type CardinalityGlyph,
  type UmlEndpointGlyph,
  type DiagramContainer,
  type DiagramModel,
  type DiagramNode,
  type FlowchartDirection,
  type NodeShape,
  type EntityAttribute,
  type ClassMember,
} from '@canvas/diagram-core';
import { getAddableShapes, nodeSize, renderNodeShape, SELECTION_STROKE } from './shapes';
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

// canvas-xig: the style popup's own fixed size — a color swatch plus two `.btn--compact` buttons
// on one row. 232 leaves ~30px of slack over the measured minimum (~200px, at the 40px swatch
// width set on the input below) so the row doesn't wrap under normal font-metric variance; 48
// covers the 28px control height plus the card's padding and border.
const STYLE_POPUP_WIDTH = 232;
const STYLE_POPUP_HEIGHT = 48;

// canvas-vcv: the ER attribute / UML member popup — a list (scrolling internally past ~5-6 rows)
// plus a fixed add-row and header/Done row, so it needs real width (room for a type/name/keys
// triple, or a kind/visibility/name/type-or-params-and-returnType row) and a taller fixed height
// than the style popup's single-row box.
const FIELDS_POPUP_WIDTH = 480;
const FIELDS_POPUP_HEIGHT = 280;

// canvas-0s3: fallback size used before the container's ResizeObserver has measured anything, and
// the effective floor beneath whatever's larger of the visible container or actual content
// bounds (see containerSize state / computeBounds below) — no longer the canvas's true fixed size.
const DEFAULT_CANVAS_WIDTH = 800;
const DEFAULT_CANVAS_HEIGHT = 500;

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
  maxWidth?: number,
): JSX.Element {
  const lines = splitLabelLines(label, maxWidth, fontSize);
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

// canvas-2ut: JSX rendering for cardinalityGlyphs' geometry — mirrors svg-renderer.ts's own
// renderCardinalityGlyph exactly (SC-004), just as `<line>`/`<circle>` JSX instead of raw SVG
// strings.
function renderCardinalityGlyphs(glyphs: CardinalityGlyph[], stroke: string): JSX.Element[] {
  return glyphs.flatMap((glyph, i) => {
    switch (glyph.kind) {
      case 'tick':
        return [<line key={i} x1={glyph.x1} y1={glyph.y1} x2={glyph.x2} y2={glyph.y2} stroke={stroke} />];
      case 'circle':
        return [<circle key={i} cx={glyph.cx} cy={glyph.cy} r={glyph.r} fill="white" stroke={stroke} />];
      case 'fork':
        return glyph.prongs.map((p, j) => (
          <line key={`${i}-${j}`} x1={glyph.apexX} y1={glyph.apexY} x2={p.x} y2={p.y} stroke={stroke} />
        ));
    }
  });
}

// canvas-7vs.3: JSX rendering for umlEndpointGlyph's geometry — mirrors svg-renderer.ts's own
// renderUmlEndpointGlyph exactly (SC-004).
function renderUmlEndpointGlyph(glyph: UmlEndpointGlyph, stroke: string, key: number | string): JSX.Element {
  switch (glyph.kind) {
    case 'triangle':
      return (
        <polygon
          key={key}
          points={`${glyph.tip.x},${glyph.tip.y} ${glyph.baseLeft.x},${glyph.baseLeft.y} ${glyph.baseRight.x},${glyph.baseRight.y}`}
          fill={glyph.filled ? stroke : 'white'}
          stroke={stroke}
        />
      );
    case 'diamond':
      return (
        <polygon
          key={key}
          points={`${glyph.near.x},${glyph.near.y} ${glyph.right.x},${glyph.right.y} ${glyph.far.x},${glyph.far.y} ${glyph.left.x},${glyph.left.y}`}
          fill={glyph.filled ? stroke : 'white'}
          stroke={stroke}
        />
      );
    case 'open-arrow':
      return (
        <g key={key}>
          <line x1={glyph.tip.x} y1={glyph.tip.y} x2={glyph.wingLeft.x} y2={glyph.wingLeft.y} stroke={stroke} />
          <line x1={glyph.tip.x} y1={glyph.tip.y} x2={glyph.wingRight.x} y2={glyph.wingRight.y} stroke={stroke} />
        </g>
      );
    case 'circle':
      return <circle key={key} cx={glyph.cx} cy={glyph.cy} r={glyph.r} fill="white" stroke={stroke} />;
  }
}

// canvas-7vs.5: a UML relationship's multiplicity label (e.g. "1", "0..*") near one endpoint —
// position comes from the shared umlCardinalityLabelPosition (SC-004).
function UmlCardinalityLabel({ position, text }: { position: { x: number; y: number }; text: string }): JSX.Element {
  return (
    <text x={position.x} y={position.y} fontSize={11}>
      {text}
    </text>
  );
}

const UML_VISIBILITY_OPTIONS: { value: '' | '+' | '-' | '#' | '~'; label: string }[] = [
  { value: '', label: 'None' },
  { value: '+', label: 'Public (+)' },
  { value: '-', label: 'Private (-)' },
  { value: '#', label: 'Protected (#)' },
  { value: '~', label: 'Package (~)' },
];

/** Splits a comma-separated `PK,FK` string into EntityAttribute.keys — trims each token and
 *  drops empties, so `"PK, "` / `" ,FK"` / `""` all behave sensibly rather than producing
 *  stray blank entries. */
function parseKeysInput(value: string): string[] {
  return value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

interface FieldsPopupProps {
  node: DiagramNode;
  model: DiagramModel;
  /** Only `'erd'` (attributes) or `'uml'` (members) ever render this popup — see the family gate
   *  at the call site. */
  dslFamily: string;
  x: number;
  y: number;
  onChange: (model: DiagramModel) => void;
  onClose: () => void;
}

/**
 * canvas-vcv: the ER attribute / UML member editor opened by renderFieldsAffordance — a scrollable
 * list of existing rows (each field commits on blur/Enter, mirroring the node/edge/container label
 * inputs' own uncontrolled-input convention elsewhere in this file) plus a fixed "add new" row.
 * A standalone component (unlike renderStylePopup, a plain closure) because the add-row needs its
 * own local draft state — it must not "become" the model's state as an uncontrolled input can,
 * since a brand-new attribute/member does not exist as a model row to commit onto until Add is
 * clicked. Mounted only while `editingFieldsNodeId === node.id`, so its state resets cleanly each
 * time it is reopened rather than needing an explicit reset after every Add.
 */
function FieldsPopup({ node, model, dslFamily, x, y, onChange, onClose }: FieldsPopupProps) {
  const isErd = dslFamily === 'erd';
  const attributes = node.attributes ?? [];
  const members = node.members ?? [];

  // ERD add-row draft.
  const [newType, setNewType] = useState('');
  const [newName, setNewName] = useState('');

  // UML add-row draft.
  const [newKind, setNewKind] = useState<'attribute' | 'method'>('attribute');
  const [newVisibility, setNewVisibility] = useState<'' | '+' | '-' | '#' | '~'>('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberType, setNewMemberType] = useState('');
  const [newParams, setNewParams] = useState('');
  const [newReturnType, setNewReturnType] = useState('');

  const commitAttribute = (index: number, patch: Partial<EntityAttribute>) => {
    const next = attributes.map((a, i) => (i === index ? { ...a, ...patch } : a));
    onChange(updateEntityAttributes(model, node.id, next));
  };
  const removeAttribute = (index: number) => {
    onChange(updateEntityAttributes(model, node.id, attributes.filter((_, i) => i !== index)));
  };
  const addAttribute = () => {
    if (!newName.trim()) return;
    const attribute: EntityAttribute = { type: newType.trim(), name: newName.trim(), keys: [] };
    onChange(updateEntityAttributes(model, node.id, [...attributes, attribute]));
    setNewType('');
    setNewName('');
  };

  const commitMember = (index: number, patch: Partial<ClassMember>) => {
    const next = members.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onChange(updateClassMembers(model, node.id, next));
  };
  // Switching kind swaps which fields apply — clears the other kind's fields rather than leaving
  // stale, no-longer-editable data (e.g. a `params` value hanging off a member now typed
  // 'attribute') silently attached underneath.
  const setMemberKind = (index: number, kind: 'attribute' | 'method') => {
    const m = members[index];
    const next: ClassMember =
      kind === 'attribute'
        ? { kind: 'attribute', visibility: m.visibility, name: m.name, type: m.type ?? '', isStatic: m.isStatic, isAbstract: m.isAbstract }
        : { kind: 'method', visibility: m.visibility, name: m.name, params: m.params ?? '', returnType: m.returnType, isStatic: m.isStatic, isAbstract: m.isAbstract };
    onChange(updateClassMembers(model, node.id, members.map((mm, i) => (i === index ? next : mm))));
  };
  const removeMember = (index: number) => {
    onChange(updateClassMembers(model, node.id, members.filter((_, i) => i !== index)));
  };
  const addMember = () => {
    if (!newMemberName.trim()) return;
    const member: ClassMember =
      newKind === 'attribute'
        ? { kind: 'attribute', visibility: newVisibility || undefined, name: newMemberName.trim(), type: newMemberType.trim() || undefined }
        : { kind: 'method', visibility: newVisibility || undefined, name: newMemberName.trim(), params: newParams, returnType: newReturnType.trim() || undefined };
    onChange(updateClassMembers(model, node.id, [...members, member]));
    setNewMemberName('');
    setNewMemberType('');
    setNewParams('');
    setNewReturnType('');
  };

  return (
    <foreignObject x={x} y={y} width={FIELDS_POPUP_WIDTH} height={FIELDS_POPUP_HEIGHT}>
      <div
        className="card"
        style={{
          padding: 'var(--space-3)',
          height: FIELDS_POPUP_HEIGHT - 8,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <div className="cluster" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <p className="section-label" style={{ margin: 0 }}>
            {isErd ? 'Attributes' : 'Members'}
          </p>
          <button
            type="button"
            className="btn btn--primary btn--compact"
            data-testid={`fields-done-${node.id}`}
            onClick={onClose}
          >
            Done
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          {isErd
            ? attributes.map((attr, i) => (
                <div key={i} className="cluster cluster--tight" style={{ flexWrap: 'nowrap' }}>
                  <input
                    data-testid={`attr-type-${node.id}-${i}`}
                    aria-label={`Attribute ${i + 1} type`}
                    defaultValue={attr.type}
                    placeholder="type"
                    style={{ width: 90, minHeight: 28, padding: '0 6px' }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => commitAttribute(i, { type: e.target.value })}
                  />
                  <input
                    data-testid={`attr-name-${node.id}-${i}`}
                    aria-label={`Attribute ${i + 1} name`}
                    defaultValue={attr.name}
                    placeholder="name"
                    style={{ width: 110, minHeight: 28, padding: '0 6px' }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => commitAttribute(i, { name: e.target.value || attr.name })}
                  />
                  <input
                    data-testid={`attr-keys-${node.id}-${i}`}
                    aria-label={`Attribute ${i + 1} keys, comma separated`}
                    defaultValue={attr.keys.join(',')}
                    placeholder="PK,FK"
                    style={{ width: 70, minHeight: 28, padding: '0 6px' }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => commitAttribute(i, { keys: parseKeysInput(e.target.value) })}
                  />
                  <button
                    type="button"
                    className="btn btn--tertiary-danger btn--compact"
                    data-testid={`attr-remove-${node.id}-${i}`}
                    aria-label={`Remove attribute ${attr.name}`}
                    onClick={() => removeAttribute(i)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))
            : members.map((member, i) => (
                <div key={i} className="cluster cluster--tight" style={{ flexWrap: 'wrap' }}>
                  <select
                    data-testid={`member-kind-${node.id}-${i}`}
                    aria-label={`Member ${i + 1} kind`}
                    value={member.kind}
                    style={{ width: 90, minHeight: 28 }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => setMemberKind(i, e.target.value as 'attribute' | 'method')}
                  >
                    <option value="attribute">Attribute</option>
                    <option value="method">Method</option>
                  </select>
                  <select
                    data-testid={`member-visibility-${node.id}-${i}`}
                    aria-label={`Member ${i + 1} visibility`}
                    value={member.visibility ?? ''}
                    style={{ width: 110, minHeight: 28 }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => commitMember(i, { visibility: (e.target.value || undefined) as ClassMember['visibility'] })}
                  >
                    {UML_VISIBILITY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <input
                    data-testid={`member-name-${node.id}-${i}`}
                    aria-label={`Member ${i + 1} name`}
                    defaultValue={member.name}
                    placeholder="name"
                    style={{ width: 100, minHeight: 28, padding: '0 6px' }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => commitMember(i, { name: e.target.value || member.name })}
                  />
                  {member.kind === 'attribute' ? (
                    <input
                      data-testid={`member-type-${node.id}-${i}`}
                      aria-label={`Member ${i + 1} type`}
                      defaultValue={member.type ?? ''}
                      placeholder="type"
                      style={{ width: 90, minHeight: 28, padding: '0 6px' }}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={(e) => commitMember(i, { type: e.target.value })}
                    />
                  ) : (
                    <>
                      <input
                        data-testid={`member-params-${node.id}-${i}`}
                        aria-label={`Member ${i + 1} parameters`}
                        defaultValue={member.params ?? ''}
                        placeholder="params"
                        style={{ width: 90, minHeight: 28, padding: '0 6px' }}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        onBlur={(e) => commitMember(i, { params: e.target.value })}
                      />
                      <input
                        data-testid={`member-return-${node.id}-${i}`}
                        aria-label={`Member ${i + 1} return type`}
                        defaultValue={member.returnType ?? ''}
                        placeholder="return type"
                        style={{ width: 90, minHeight: 28, padding: '0 6px' }}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        onBlur={(e) => commitMember(i, { returnType: e.target.value || undefined })}
                      />
                    </>
                  )}
                  <button
                    type="button"
                    className="btn btn--tertiary-danger btn--compact"
                    data-testid={`member-remove-${node.id}-${i}`}
                    aria-label={`Remove member ${member.name}`}
                    onClick={() => removeMember(i)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              ))}
        </div>

        {/* "Add new" row — always rendered regardless of list length (a brand-new entity/class with
            zero attributes/members needs this most), and the one control guaranteed to exist for
            Escape's autoFocus target below. */}
        {isErd ? (
          <div className="cluster cluster--tight" style={{ flexWrap: 'nowrap', borderTop: 'var(--border-width) solid var(--border-subtle)', paddingTop: 'var(--space-2)' }}>
            <input
              data-testid={`attr-new-type-${node.id}`}
              aria-label="New attribute type"
              autoFocus
              value={newType}
              placeholder="type"
              style={{ width: 90, minHeight: 28, padding: '0 6px' }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setNewType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addAttribute();
              }}
            />
            <input
              data-testid={`attr-new-name-${node.id}`}
              aria-label="New attribute name"
              value={newName}
              placeholder="name"
              style={{ width: 110, minHeight: 28, padding: '0 6px' }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addAttribute();
              }}
            />
            <button
              type="button"
              className="btn btn--secondary btn--compact"
              data-testid={`attr-add-${node.id}`}
              disabled={!newName.trim()}
              onClick={addAttribute}
            >
              <Icon name="plus" size={12} />
              Add
            </button>
          </div>
        ) : (
          <div className="cluster cluster--tight" style={{ flexWrap: 'wrap', borderTop: 'var(--border-width) solid var(--border-subtle)', paddingTop: 'var(--space-2)' }}>
            <select
              data-testid={`member-new-kind-${node.id}`}
              aria-label="New member kind"
              autoFocus
              value={newKind}
              style={{ width: 90, minHeight: 28 }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setNewKind(e.target.value as 'attribute' | 'method')}
            >
              <option value="attribute">Attribute</option>
              <option value="method">Method</option>
            </select>
            <select
              data-testid={`member-new-visibility-${node.id}`}
              aria-label="New member visibility"
              value={newVisibility}
              style={{ width: 110, minHeight: 28 }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setNewVisibility(e.target.value as '' | '+' | '-' | '#' | '~')}
            >
              {UML_VISIBILITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <input
              data-testid={`member-new-name-${node.id}`}
              aria-label="New member name"
              value={newMemberName}
              placeholder="name"
              style={{ width: 100, minHeight: 28, padding: '0 6px' }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setNewMemberName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addMember();
              }}
            />
            {newKind === 'attribute' ? (
              <input
                data-testid={`member-new-type-${node.id}`}
                aria-label="New member type"
                value={newMemberType}
                placeholder="type"
                style={{ width: 90, minHeight: 28, padding: '0 6px' }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setNewMemberType(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addMember();
                }}
              />
            ) : (
              <>
                <input
                  data-testid={`member-new-params-${node.id}`}
                  aria-label="New member parameters"
                  value={newParams}
                  placeholder="params"
                  style={{ width: 90, minHeight: 28, padding: '0 6px' }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => setNewParams(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addMember();
                  }}
                />
                <input
                  data-testid={`member-new-return-${node.id}`}
                  aria-label="New member return type"
                  value={newReturnType}
                  placeholder="return type"
                  style={{ width: 90, minHeight: 28, padding: '0 6px' }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onChange={(e) => setNewReturnType(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addMember();
                  }}
                />
              </>
            )}
            <button
              type="button"
              className="btn btn--secondary btn--compact"
              data-testid={`member-add-${node.id}`}
              disabled={!newMemberName.trim()}
              onClick={addMember}
            >
              <Icon name="plus" size={12} />
              Add
            </button>
          </div>
        )}
      </div>
    </foreignObject>
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

/**
 * canvas-xig: where the style popup renders relative to its anchor shape/edge. Prefers just below
 * the anchor (`anchorBottom`, matching the original placement below a node / below an edge's
 * midpoint) and only flips above it (`anchorTop`) when there isn't room below — then clamps
 * horizontally so it never crosses the canvas's own left/right edge either. `canvasWidth`/
 * `canvasHeight` are the SVG's *current* actual size (canvas-0s3: no longer a fixed 800x500 —
 * clamping against a stale constant would misplace the popup once the canvas grows past it).
 */
function popupPosition(
  anchorTop: number,
  anchorBottom: number,
  desiredX: number,
  canvasWidth: number,
  canvasHeight: number,
  // canvas-vcv: defaulted to the style popup's own size so both pre-existing call sites (edge and
  // node style popups) are unaffected — the fields popup below is the only caller passing its own,
  // larger, explicit width/height.
  popupWidth: number = STYLE_POPUP_WIDTH,
  popupHeight: number = STYLE_POPUP_HEIGHT,
): { x: number; y: number } {
  const margin = 4;
  const below = anchorBottom + margin;
  const fitsBelow = below + popupHeight <= canvasHeight - margin;
  const y = fitsBelow ? below : anchorTop - popupHeight - margin;
  return {
    x: Math.min(Math.max(desiredX, margin), canvasWidth - popupWidth - margin),
    y: Math.min(Math.max(y, margin), canvasHeight - popupHeight - margin),
  };
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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** canvas-558: marquee hit-test — ANY overlap selects, not full containment. Picked over
 *  containment as the more forgiving/discoverable default for a first version (a marquee that
 *  only grazes a node's edge still catches it, matching how most users expect a drag-select to
 *  behave without first learning a directional containment-vs-intersection rule like Visio's). */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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
  // canvas-esn: the direction Auto Layout runs with, always visible (unlike connectArrowStyle,
  // which only matters mid-connect) — defaults to the model's own already-parsed direction so
  // re-running layout on an imported diagram doesn't silently flip its axis.
  const [layoutDirection, setLayoutDirection] = useState<FlowchartDirection>(model.direction ?? 'TD');
  // Re-syncs the picker whenever model.direction changes for a reason OTHER than this picker
  // itself (a DSL-panel edit setting `graph LR`, a version restore) — a plain useState initializer
  // only runs once at mount, so without this the picker would silently go stale and a later Auto
  // Layout click could stomp a direction the user just set a different way.
  useEffect(() => {
    if (model.direction) setLayoutDirection(model.direction);
  }, [model.direction]);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [editingContainerId, setEditingContainerId] = useState<string | null>(null);
  // canvas-xig: separate from editingNodeId/editingEdgeId (label editing) — a distinct affordance
  // next to the pencil, not merged into it, so the existing rename flow's e2e coverage
  // (label-affordance.spec.ts) stays untouched.
  const [stylingNodeId, setStylingNodeId] = useState<string | null>(null);
  const [stylingEdgeId, setStylingEdgeId] = useState<string | null>(null);
  // canvas-vcv: a third, separate affordance next to the pencil/palette — node-only (ER attributes/
  // UML members are node-level fields; edges/containers have neither), so unlike stylingNodeId/
  // stylingEdgeId there is no matching "Edge" counterpart.
  const [editingFieldsNodeId, setEditingFieldsNodeId] = useState<string | null>(null);
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  // canvas-u7e: edges had no selection state at all — the only ways to remove a connector were
  // deleting one of its endpoint nodes (which cascades but also destroys the node) or hand-editing
  // the DSL. Single-select only (no shift-multi-select precedent for edges), mirroring
  // selectedContainerId's own pattern rather than folding into selectedIds (which would need
  // groupSelected/its button to start distinguishing node ids from edge ids within the same Set).
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Which element the pointer is over. Paired with selection below so the edit affordance is
  // reachable by keyboard too — hover alone would be unusable without a pointer (FR-017).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // `kind` distinguishes the four drags that share the pointer handlers: moving a shape, moving
  // a container (which carries its members), resizing a container, and (canvas-558) a
  // rubber-band marquee selection started on empty canvas background.
  const dragState = useRef<
    { kind: 'node' | 'container'; id: string; offsetX: number; offsetY: number }
    | { kind: 'resize'; id: string; originX: number; originY: number }
    | { kind: 'marquee'; startX: number; startY: number; additive: boolean }
    | null
  >(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // canvas-558: the live selection rectangle, rendered as an overlay and cleared on pointerup —
  // separate from dragState (a ref, so updating it wouldn't re-render the visible rectangle).
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  // A completed marquee drag finalizes selectedIds in handlePointerUp; the browser then still
  // fires a plain `click` on the same target right after (mouseup/mousedown landed on the same
  // element regardless of how far the pointer travelled between them) — without this flag the
  // svg's own onClick handler below would immediately clear the selection the drag just made.
  const suppressNextCanvasClick = useRef(false);

  // canvas-0s3: the canvas SVG is sized to fit whichever is larger of the actual visible
  // container or real content bounds, so a shape placed beyond the initial viewport becomes
  // scrollable (via the container's existing overflow:auto) rather than clipped/unreachable.
  // Defaults to the old fixed size until the ResizeObserver below reports a real measurement —
  // Canvas is only ever rendered inside `.editor__canvas` (DiagramEditor.tsx), so a class-selector
  // `closest()` lookup is reliable without needing a ref forwarded across that component boundary.
  const [containerSize, setContainerSize] = useState({ width: DEFAULT_CANVAS_WIDTH, height: DEFAULT_CANVAS_HEIGHT });

  useEffect(() => {
    const container = svgRef.current?.closest('.editor__canvas');
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ width, height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

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

  const handleAutoLayout = () => {
    onChange(autoLayout(model, layoutDirection));
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
        // canvas-vcv follow-up: a plain arrowhead is not valid ER notation at all -- real
        // erDiagram relationships always show crow's-foot cardinality on both ends, never a
        // directional arrow. Without this, a connector drawn here in an ER diagram rendered as a
        // plain arrow (wrong notation) until the DSL was saved and reparsed, at which point
        // erd.ts's own DEFAULT_CARDINALITY fallback silently reinterpreted it as crow's-foot --
        // an inconsistent, save-dependent visual. Giving the edge real cardinality data up front
        // makes the canvas ER-correct from the moment it's drawn.
        const erDefaults =
          dslFamily === 'erd'
            ? { erSourceCardinality: DEFAULT_ER_SOURCE_CARDINALITY, erTargetCardinality: DEFAULT_ER_TARGET_CARDINALITY }
            : {};
        onChange(
          addEdge(model, {
            sourceId: reversed ? node.id : connectSourceId,
            targetId: reversed ? connectSourceId : node.id,
            arrow: connectArrowStyle === 'both' || connectArrowStyle === 'none' ? connectArrowStyle : undefined,
            ...erDefaults,
          }),
        );
        setConnectSourceId(null);
        setConnectMode(false);
      }
      return;
    }

    // canvas-558: Ctrl/Cmd+click toggles a node into/out of the selection exactly like
    // Shift+click already did — standard Windows diagram-app convention (Visio, PowerPoint,
    // draw.io) treats either modifier interchangeably on a freeform canvas, rather than reserving
    // Shift for range-select (which has no natural meaning here — nodes have no inherent order).
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
      setSelectedEdgeId(null);
      return;
    }
    setSelectedIds(new Set([node.id]));
    setSelectedContainerId(null);
    setSelectedEdgeId(null);

    // canvas-7vs.1: sequence-diagram layout is always computed from DSL order, never dragged
    // (FR-013) — selection above still applies normally; only starting a position-drag is skipped.
    if (dslFamily === 'sequence') return;

    const point = toClientPoint(event);
    dragState.current = {
      kind: 'node',
      id: node.id,
      offsetX: point.x - node.position.x,
      offsetY: point.y - node.position.y,
    };
  };

  // canvas-u7e: edges aren't draggable, so unlike node/container pointer-down this only sets
  // selection — no dragState entry.
  const handleEdgePointerDown = (edgeId: string) => (event: React.PointerEvent) => {
    event.stopPropagation();
    if (connectMode) return;
    setSelectedEdgeId(edgeId);
    setSelectedIds(new Set());
    setSelectedContainerId(null);
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
    setSelectedEdgeId(null);

    // canvas-7vs.1: same computed-only-layout guard as handleNodePointerDown above (FR-013).
    if (dslFamily === 'sequence') return;

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

    if (drag.kind === 'marquee') {
      setMarqueeRect({
        x: Math.min(drag.startX, point.x),
        y: Math.min(drag.startY, point.y),
        width: Math.abs(point.x - drag.startX),
        height: Math.abs(point.y - drag.startY),
      });
      return;
    }

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

  const handlePointerUp = (event: React.PointerEvent) => {
    const drag = dragState.current;
    dragState.current = null;

    if (drag?.kind === 'marquee') {
      setMarqueeRect(null);
      const point = toClientPoint(event);
      const rect: Rect = {
        x: Math.min(drag.startX, point.x),
        y: Math.min(drag.startY, point.y),
        width: Math.abs(point.x - drag.startX),
        height: Math.abs(point.y - drag.startY),
      };
      // A drag that barely moved is really just a click on empty background — let the svg's own
      // onClick handler clear the selection as usual instead of treating it as a (trivial,
      // empty-rect) marquee.
      if (rect.width < 3 && rect.height < 3) return;

      const hitIds = model.nodes.filter((n) => rectsIntersect(rect, { ...n.position, ...nodeSize(n) })).map((n) => n.id);
      setSelectedIds((prev) => (drag.additive ? new Set([...prev, ...hitIds]) : new Set(hitIds)));
      setSelectedContainerId(null);
      setSelectedEdgeId(null);
      // The click that follows this pointerup lands on the same <svg> background and would
      // otherwise immediately clear the selection just made above.
      suppressNextCanvasClick.current = true;
      return;
    }

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

  /** canvas-xig: a second, separate small control next to renderEditAffordance — deliberately not
   *  merged into the same popup/button, so the existing rename flow (label-affordance.spec.ts)
   *  is untouched. Same hover/selection/focus reveal rule as the pencil. */
  const renderStyleAffordance = (id: string, x: number, y: number, onActivate: () => void, label: string) => (
    <foreignObject x={x} y={y} width={22} height={22}>
      <button
        type="button"
        className="canvas-edit-affordance"
        data-testid={`edit-style-${id}`}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Icon name="palette" size={12} />
      </button>
    </foreignObject>
  );

  /** canvas-vcv: a third, separate control alongside the pencil/palette pair — opens FieldsPopup.
   *  Node-only and gated to erd/uml at the call site (every node in an ERD diagram is an entity;
   *  every node in a UML diagram is a class — there is no other node kind in either family). Same
   *  hover/selection/focus reveal rule as the other two. */
  const renderFieldsAffordance = (id: string, x: number, y: number, onActivate: () => void, label: string) => (
    <foreignObject x={x} y={y} width={22} height={22}>
      <button
        type="button"
        className="canvas-edit-affordance"
        data-testid={`edit-fields-${id}`}
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Icon name="rows" size={12} />
      </button>
    </foreignObject>
  );

  /** Small color-picker popup opened by renderStyleAffordance. Uses an explicit Done button
   *  rather than blur-to-commit (unlike the label editors) — a native OS color-picker dialog has
   *  inconsistent focus/blur timing across browsers, so relying on blur alone here would be a real
   *  flakiness risk for a brand-new control. Escape also closes it, matching the label editors. */
  const renderStylePopup = (
    id: string,
    x: number,
    y: number,
    currentColor: string | undefined,
    onPick: (color: string) => void,
    onClear: () => void,
    onClose: () => void,
  ) => (
    <foreignObject x={x} y={y} width={STYLE_POPUP_WIDTH} height={STYLE_POPUP_HEIGHT}>
      <div
        className="card cluster"
        style={{ padding: 'var(--space-2)', flexWrap: 'nowrap' }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        {/* Trimmed to match the compact buttons' 28px height and given padding: 0 — the global
            `input` rule's default min-height (36px) and 12px inline padding, applied to a native
            color swatch, wasted popup width on empty space around a tiny swatch and was part of
            why 3 controls no longer fit on one row at 200px. */}
        <input
          type="color"
          data-testid={`style-color-input-${id}`}
          aria-label="Choose a color"
          autoFocus
          value={currentColor ?? '#ffffff'}
          onChange={(event) => onPick(event.target.value)}
          style={{ width: 40, height: 28, minHeight: 0, padding: 0, flexShrink: 0 }}
        />
        <button type="button" className="btn btn--tertiary btn--compact" data-testid={`style-clear-${id}`} onClick={onClear}>
          Clear
        </button>
        <button type="button" className="btn btn--primary btn--compact" data-testid={`style-done-${id}`} onClick={onClose}>
          Done
        </button>
      </div>
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
    if (selectedIds.size === 0 && !selectedContainerId && !selectedEdgeId) return;
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
    // canvas-u7e: removeEdge only ever touches the edge itself — its endpoint nodes are untouched.
    if (selectedEdgeId) {
      next = removeEdge(next, selectedEdgeId);
    }
    onChange(next);
    setSelectedIds(new Set());
    setSelectedContainerId(null);
    setSelectedEdgeId(null);
    setShowDeleteConfirm(false);
  };

  const deleteConfirmMessage = selectedContainerId
    ? 'Delete this container? The shapes inside it will be kept on the canvas.'
    : selectedEdgeId
      ? 'Delete this connector? This cannot be undone.'
      : `Delete ${selectedIds.size} selected shape${selectedIds.size === 1 ? '' : 's'}? This cannot be undone.`;

  const cancelDeleteSelected = () => setShowDeleteConfirm(false);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't intercept Delete/Backspace while a label is being typed into.
    if (editingNodeId || editingEdgeId) return;
    const tag = (event.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && (selectedIds.size > 0 || selectedEdgeId)) {
      event.preventDefault();
      requestDeleteSelected();
    }
  };

  // canvas-7vs.10: empty for sequence diagrams (getAddableShapes' own doc comment) — the whole
  // "Shapes" section is hidden rather than shown with nothing in its grid.
  const addableShapes = getAddableShapes(dslFamily);

  const toolbar = (
    <div role="toolbar" aria-label="Diagram tools">
      {addableShapes.length > 0 && (
        <div className="rail-section">
          <p className="section-label rail-section__label">Shapes</p>
          <div className="shape-grid">
            {addableShapes.map(({ shape, label }) => (
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
      )}

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
            disabled={selectedIds.size === 0 && !selectedContainerId && !selectedEdgeId}
            onClick={requestDeleteSelected}
          >
            <Icon name="trash" />
            Delete Selected
          </button>
          {/* canvas-esn: flowchart-family only (v1) — the same dslFamily scoping already used for
              getAddableShapes above. Not a mode like Connect: one click rearranges the whole
              diagram in the picked direction and the picker stays visible so it can be changed and
              re-run at any time, mirroring docs/mermaid_dagre_demo.html's own select+button shape. */}
          {dslFamily === 'flowchart' && (
            <>
              <label className="field__label" htmlFor="auto-layout-direction">
                Layout Direction
                <select
                  id="auto-layout-direction"
                  data-testid="auto-layout-direction"
                  value={layoutDirection}
                  onChange={(e) => setLayoutDirection(e.target.value as FlowchartDirection)}
                >
                  <option value="TD">Top → Down</option>
                  <option value="LR">Left → Right</option>
                  <option value="BT">Bottom → Up</option>
                  <option value="RL">Right → Left</option>
                </select>
              </label>
              <button type="button" className="btn btn--secondary" data-testid="auto-layout" onClick={handleAutoLayout}>
                <Icon name="layout" />
                Auto Layout
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  // canvas-0s3: whichever is larger of the visible container and actual content — never smaller
  // than the container (so the drawable area always fills the visible viewport, matching what the
  // dot-grid background already implies is drawable) and grows past it for content that needs more.
  const contentBounds = computeBounds(model);
  const canvasWidth = Math.max(containerSize.width, contentBounds.width);
  const canvasHeight = Math.max(containerSize.height, contentBounds.height);
  // canvas-7vs.7: built once per render, not per edge, for architectureEndpointBox's {group}
  // parent-container lookup.
  const containersById = new Map(model.containers.map((c) => [c.id, c]));
  // canvas-7vs.1: the one shared lifeline/timeline geometry calculation, also consumed by the
  // export renderer (svg-renderer.ts's renderSequenceSvg) — never recomputed independently here
  // (contracts/sequence-layout-contract.md). `null` for every non-sequence family, so every
  // sequence-specific branch below is a simple `sequenceLayout &&` guard.
  const sequenceLayout = dslFamily === 'sequence' ? computeSequenceLayout(model) : null;

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
        width={canvasWidth}
        height={canvasHeight}
        // The border moved to the surrounding container so the SVG can fill it and let the
        // dot-grid background show through; `touchAction` stays inline because it is behaviour,
        // not styling. width/height above are computed (canvas-0s3), not CSS-stretched — no
        // viewBox, so the origin stays at the container's top-left and drag coordinate maths
        // (1 SVG unit = 1 CSS pixel) is unchanged regardless of how large the canvas grows.
        style={{ touchAction: 'none' }}
        onPointerDown={(event) => {
          // canvas-558: a pointer-down that reaches here (not stopped by a node/edge/container's
          // own handler) is on empty canvas background — start a marquee-select drag. Every other
          // shape's pointerdown handler already calls stopPropagation, so this can't fire for one
          // of those; the `target === currentTarget` check is defense in depth, not the only
          // guard.
          if (event.target !== event.currentTarget || connectMode) return;
          const point = toClientPoint(event);
          dragState.current = {
            kind: 'marquee',
            startX: point.x,
            startY: point.y,
            additive: event.shiftKey || event.ctrlKey || event.metaKey,
          };
          setMarqueeRect({ x: point.x, y: point.y, width: 0, height: 0 });
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={(event) => {
          if (suppressNextCanvasClick.current) {
            suppressNextCanvasClick.current = false;
            return;
          }
          // Only deselect on a genuine click on the canvas background — not one that bubbled up
          // from a node/edge click, which already set the selection this same interaction.
          if (event.target === event.currentTarget) {
            setSelectedIds(new Set());
            setSelectedContainerId(null);
            setSelectedEdgeId(null);
          }
        }}
      >
        {model.containers.map((rawContainer) => {
          // canvas-7vs.1: activate/deactivate and else/and/option get an entirely different
          // geometry (a bar / a divider line, not a resizable dashed box) — handled as their own
          // early-return branch rather than retrofitted into the generic box JSX below, which
          // stays exactly as it was (canvas/export parity comment preserved) for every role that
          // still IS a generic box (loop/alt/opt/par/critical/break/rect/note-*/box).
          if (sequenceLayout) {
            if (rawContainer.role === 'deactivate') return null; // drawn as part of its paired 'activate' bar
            if (rawContainer.role === 'activate') {
              const bar = sequenceLayout.activations.get(rawContainer.id);
              if (!bar) return null;
              const isSelected = selectedContainerId === rawContainer.id;
              return (
                <rect
                  key={rawContainer.id}
                  data-testid={`container-${rawContainer.id}`}
                  x={bar.x - bar.width / 2}
                  y={bar.yStart}
                  width={bar.width}
                  height={bar.yEnd - bar.yStart}
                  fill="#ffffff"
                  stroke={isSelected ? '#2563eb' : '#333333'}
                  strokeWidth={isSelected ? 2 : 1}
                  onPointerDown={handleContainerPointerDown(rawContainer)}
                />
              );
            }
            const dividerGeom = sequenceLayout.blocks.get(rawContainer.id);
            if (dividerGeom?.isDivider) {
              return (
                <g key={rawContainer.id} data-testid={`container-${rawContainer.id}`} onPointerDown={handleContainerPointerDown(rawContainer)}>
                  <line x1={dividerGeom.x} y1={dividerGeom.y} x2={dividerGeom.x + dividerGeom.width} y2={dividerGeom.y} stroke={CONTROL_FLOW_STROKE} strokeDasharray={CONTROL_FLOW_DASHARRAY} />
                  {rawContainer.label && (
                    <text x={dividerGeom.x + 8} y={dividerGeom.y - 4} fontSize={12}>
                      {`${rawContainer.role} ${rawContainer.label}`}
                    </text>
                  )}
                </g>
              );
            }
          }
          // canvas-7vs.1: for every remaining role, position/size (and, for a block, the label
          // actually drawn — "loop Retry", not just "Retry", mirroring svg-renderer.ts's
          // renderSequenceBlock exactly) come from the computed layout instead of the placeholder
          // node/container.position (research.md §1). Editing a block's label still edits its
          // real underlying `label` field, not this composed display string — a disclosed, minor
          // interaction nuance (the rename textbox's default value shows the composed text) judged
          // not worth a bespoke edit flow for a corner label canvas-7vs.8 will restyle anyway.
          const container = (() => {
            if (!sequenceLayout) return rawContainer;
            const block = sequenceLayout.blocks.get(rawContainer.id);
            if (block) {
              const label = rawContainer.role === 'rect' ? '' : `${rawContainer.role} ${rawContainer.label}`.trim();
              return { ...rawContainer, position: { x: block.x, y: block.y }, size: { width: block.width, height: block.height }, label };
            }
            const note = sequenceLayout.notes.get(rawContainer.id);
            if (note) return { ...rawContainer, position: note };
            const box = sequenceLayout.boxes.get(rawContainer.id);
            if (box) return { ...rawContainer, position: { x: box.x, y: box.y }, size: { width: box.width, height: box.height } };
            return rawContainer;
          })();
          const size = container.size ?? { width: 300, height: 200 };
          const isSelected = selectedContainerId === container.id;
          // canvas-7vs.8: mirrors svg-renderer.ts's containerRoleStyle exactly (SC-004) — every
          // role gets its own default fill/stroke/dash instead of the one-size-fits-all box every
          // container used to render as. Loop/alt/opt/par/critical/break additionally get the
          // same corner tab svg-renderer.ts's dedicated renderSequenceBlock draws (this generic
          // JSX is what actually renders them on canvas — Canvas.tsx has no separate block
          // function the way svg-renderer.ts does, per the `container` shadow-copy above).
          const roleStyle = containerRoleStyle(container.role);
          const isLabeledControlFlowBlock = Boolean(container.role && LABELED_CONTROL_FLOW_ROLES.has(container.role));
          const stroke = isSelected ? '#2563eb' : isLabeledControlFlowBlock ? CONTROL_FLOW_STROKE : roleStyle.stroke;
          const dasharray = isLabeledControlFlowBlock ? CONTROL_FLOW_DASHARRAY : roleStyle.strokeDasharray;
          // canvas-7vs.9: a leader line from this container's center to each attached node's own
          // position — a sequence note's target is its participant's lifeline (already resolved
          // via the `note`/`sequenceLayout` lookups above are position-only, so re-derive here from
          // sequenceLayout directly); every other family's target is the attached node's own
          // rendered center (nodeSize/node.position, same convention edges already use).
          const connectorTargets = (rawContainer.attachedNodeIds ?? [])
            .map((id) => {
              if (sequenceLayout) {
                const lifeline = sequenceLayout.lifelines.get(id);
                return lifeline ? { x: lifeline.x, y: container.position.y + size.height / 2 } : undefined;
              }
              const target = model.nodes.find((n) => n.id === id);
              if (!target) return undefined;
              const targetSize = nodeSize(target);
              return { x: target.position.x + targetSize.width / 2, y: target.position.y + targetSize.height / 2 };
            })
            .filter((t): t is { x: number; y: number } => t !== undefined);
          const boxCenterX = container.position.x + size.width / 2;
          const boxCenterY = container.position.y + size.height / 2;
          return (
            <g
              key={container.id}
              data-testid={`container-${container.id}`}
              onPointerDown={handleContainerPointerDown(container)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingContainerId(container.id);
              }}
              style={{ cursor: sequenceLayout ? 'default' : 'move' }}
            >
              {connectorTargets.map((t, i) => (
                <line key={i} x1={boxCenterX} y1={boxCenterY} x2={t.x} y2={t.y} stroke="#999999" strokeDasharray="2,2" />
              ))}
              {/* canvas-7vs.2: an explicit style.fillColor mirrors svg-renderer.ts's renderContainer
                  exactly (a sequence `rect <color> ... end` highlight's whole point is this
                  color). A role default of 'none' becomes 'transparent' here instead — unlike the
                  export renderer, this is an interactive canvas: fill="none" isn't painted at all,
                  so (per SVG's default pointer-events behavior) clicks over the container's
                  interior stop hitting it, breaking click-to-select/drag/resize on every container
                  with no fillColor set (caught by containers.spec.ts's own e2e coverage failing in
                  CI -- a real regression, not a cosmetic nit). */}
              <rect
                x={container.position.x}
                y={container.position.y}
                width={size.width}
                height={size.height}
                fill={container.style?.fillColor ?? (roleStyle.defaultFill === 'none' ? 'transparent' : roleStyle.defaultFill)}
                stroke={stroke}
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray={dasharray}
              />
              {isLabeledControlFlowBlock && (
                <rect
                  x={container.position.x}
                  y={container.position.y}
                  width={Math.min(size.width, container.label.length * 7 + 16)}
                  height={18}
                  fill={CONTROL_FLOW_TAB_FILL}
                  stroke={stroke}
                />
              )}
              {roleStyle.headerBand && (
                <rect x={container.position.x} y={container.position.y} width={size.width} height={20} fill={roleStyle.stroke} opacity={0.18} />
              )}
              {editingContainerId !== container.id && (
                <text x={container.position.x + 8} y={container.position.y + (isLabeledControlFlowBlock ? 14 : roleStyle.headerBand ? 14 : 16)} fontSize={12}>
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
                  element count is unchanged and the drag performance gate is unaffected.
                  canvas-7vs.1: hidden entirely for sequence diagrams — size is always computed
                  (FR-013), so a resize would be silently overwritten on the very next render. */}
              {isSelected && !sequenceLayout && (
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
          // canvas-7vs.1: a sequence message's endpoints come straight from the computed lifeline
          // x-positions and the message's own computed row — never from node.position (a
          // placeholder for this family, research.md §1) and never clipped (canvas-1rq's concern
          // doesn't apply: a message is drawn below the header row, never underneath a node).
          const sequenceMessage = sequenceLayout?.messages.get(edge.id);
          const sourceLifeline = sequenceLayout?.lifelines.get(edge.sourceId);
          const targetLifeline = sequenceLayout?.lifelines.get(edge.targetId);
          const isSequenceSelfMessage = Boolean(sequenceMessage?.isSelfMessage);
          const from =
            sequenceMessage && sourceLifeline
              ? { x: sourceLifeline.x, y: sequenceMessage.y }
              : { x: source.position.x + nodeSize(source).width / 2, y: source.position.y + nodeSize(source).height / 2 };
          const to =
            sequenceMessage && targetLifeline
              ? { x: targetLifeline.x, y: sequenceMessage.y }
              : { x: target.position.x + nodeSize(target).width / 2, y: target.position.y + nodeSize(target).height / 2 };
          const midX = isSequenceSelfMessage ? from.x + SELF_MESSAGE_LOOP_WIDTH / 2 : (from.x + to.x) / 2;
          const midY = (from.y + to.y) / 2;
          // canvas-1rq: clip each endpoint to its own node's boundary — otherwise the arrowhead
          // (and the line segment inside each node) is hidden underneath the node's opaque fill,
          // since nodes render on top of edges. Must match svg-renderer.ts exactly (SC-004).
          // canvas-7vs.7: {group} escalates the clip box to the parent container's boundary
          // instead of the node's own (architectureEndpointBox falls back to the node's own box
          // for every non-architecture edge, since sourceIsGroup/targetIsGroup are always
          // undefined there).
          const sourceBox = architectureEndpointBox(source, edge.sourceIsGroup, containersById);
          const targetBox = architectureEndpointBox(target, edge.targetIsGroup, containersById);
          // canvas-7vs.6: an explicit :T/:B/:L/:R anchor hint pins the endpoint to that side
          // instead of clipEdgeEndpoint's direction-toward-the-other-node default.
          const clippedFrom = sequenceMessage
            ? from
            : edge.sourceAnchor
              ? clipToAnchorSide(sourceBox.center, sourceBox.size, edge.sourceAnchor)
              : clipEdgeEndpoint(sourceBox.center, sourceBox.size, sourceBox.shape, targetBox.center.x, targetBox.center.y);
          const clippedTo = sequenceMessage
            ? to
            : edge.targetAnchor
              ? clipToAnchorSide(targetBox.center, targetBox.size, edge.targetAnchor)
              : clipEdgeEndpoint(targetBox.center, targetBox.size, targetBox.shape, sourceBox.center.x, sourceBox.center.y);
          const isEditingThisEdge = editingEdgeId === edge.id;
          const isSelected = selectedEdgeId === edge.id;
          // canvas-xig: centered under the connector's midpoint, clamped/flipped by popupPosition
          // so it never renders past the canvas's own edges (research note in that function).
          const stylePopupPos = popupPosition(midY, midY, midX - STYLE_POPUP_WIDTH / 2, canvasWidth, canvasHeight);
          // canvas-2ut: mirrors svg-renderer.ts's renderEdge crow's-foot branch exactly — both
          // endpoints' glyphs come from the shared cardinalityGlyphs calculation, so canvas and
          // export agree (SC-004). The target token is reversed here for the same reason
          // svg-renderer.ts's own comment explains: it's written nearest-line-character-first in
          // the DSL, while cardinalityGlyphs expects nearest-node-first.
          const hasErCardinality = Boolean(edge.erSourceCardinality && edge.erTargetCardinality);
          const cardinalityGlyphList = hasErCardinality
            ? [
                ...cardinalityGlyphs(clippedFrom, to.x - from.x, to.y - from.y, edge.erSourceCardinality!),
                ...cardinalityGlyphs(clippedTo, from.x - to.x, from.y - to.y, [...edge.erTargetCardinality!].reverse().join('')),
              ]
            : [];
          // canvas-7vs.3: mirrors svg-renderer.ts's renderEdge UML branch exactly — same shared
          // umlEndpointMarkers lookup + umlEndpointGlyph geometry, so canvas and export agree
          // (SC-004). canvas-7vs.5: multiplicity labels are independent of umlRelationKind.
          const umlMarkers = edge.umlRelationKind ? umlEndpointMarkers(edge.umlRelationKind) : undefined;
          const umlGlyphList = [
            umlMarkers?.source ? umlEndpointGlyph(clippedFrom, to.x - from.x, to.y - from.y, umlMarkers.source) : null,
            umlMarkers?.target ? umlEndpointGlyph(clippedTo, from.x - to.x, from.y - to.y, umlMarkers.target) : null,
          ].filter((glyph): glyph is UmlEndpointGlyph => glyph !== null);
          return (
            <g
              key={edge.id}
              data-testid={`edge-${edge.id}`}
              onPointerDown={handleEdgePointerDown(edge.id)}
              onPointerEnter={() => setHoveredId(edge.id)}
              onPointerLeave={() => setHoveredId((current) => (current === edge.id ? null : current))}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingEdgeId(edge.id);
              }}
            >
              {/* canvas-7vs.1: a self-message (source === target participant) draws as a small
                  loop out from and back into its own lifeline (research.md §5) instead of the
                  ordinary two-point line — same stroke/width/dasharray/marker props either way. */}
              {isSequenceSelfMessage ? (
                <path
                  d={`M ${from.x} ${from.y} H ${from.x + SELF_MESSAGE_LOOP_WIDTH} V ${from.y + 20} H ${from.x}`}
                  fill="none"
                  stroke={isSelected ? SELECTION_STROKE : (edge.style?.strokeColor ?? '#333')}
                  strokeWidth={isSelected ? 2 : (edge.style?.strokeWidth ?? (edge.lineStyle === 'thick' ? DEFAULT_THICK_STROKE_WIDTH : undefined))}
                  strokeDasharray={edge.style?.strokeDasharray ?? (edge.lineStyle === 'dotted' ? DEFAULT_DOTTED_DASHARRAY : undefined)}
                  markerEnd={edge.arrow === 'none' ? undefined : 'url(#arrow)'}
                />
              ) : (
                <line
                  x1={clippedFrom.x}
                  y1={clippedFrom.y}
                  x2={clippedTo.x}
                  y2={clippedTo.y}
                  // canvas-u7e: selection overrides color the same way node selection does
                  // (shapes.tsx's SELECTION_STROKE) — including for an invisible connector, so a
                  // selected-but-invisible edge still gives visible feedback about what's about to
                  // be deleted.
                  stroke={isSelected ? SELECTION_STROKE : edge.lineStyle === 'invisible' ? 'none' : (edge.style?.strokeColor ?? '#333')}
                  strokeWidth={isSelected ? 2 : (edge.style?.strokeWidth ?? (edge.lineStyle === 'thick' ? DEFAULT_THICK_STROKE_WIDTH : undefined))}
                  strokeDasharray={
                    edge.style?.strokeDasharray ??
                    (edge.lineStyle === 'dotted' || umlMarkers?.dashed ? DEFAULT_DOTTED_DASHARRAY : undefined)
                  }
                  // canvas-2ut/canvas-7vs.3: an ER relationship's crow's-foot glyphs or a UML
                  // relationship's own marker (below) replace the generic arrowhead entirely.
                  markerStart={
                    edge.lineStyle !== 'invisible' && !hasErCardinality && !umlMarkers && edge.arrow === 'both'
                      ? 'url(#arrow)'
                      : undefined
                  }
                  markerEnd={
                    edge.lineStyle === 'invisible' || hasErCardinality || umlMarkers || edge.arrow === 'none'
                      ? undefined
                      : 'url(#arrow)'
                  }
                />
              )}
              {edge.lineStyle !== 'invisible' &&
                hasErCardinality &&
                renderCardinalityGlyphs(cardinalityGlyphList, isSelected ? SELECTION_STROKE : (edge.style?.strokeColor ?? '#333'))}
              {edge.lineStyle !== 'invisible' &&
                umlGlyphList.map((glyph, i) =>
                  renderUmlEndpointGlyph(glyph, isSelected ? SELECTION_STROKE : (edge.style?.strokeColor ?? '#333'), i),
                )}
              {edge.lineStyle !== 'invisible' && edge.sourceCardinality && (
                <UmlCardinalityLabel position={umlCardinalityLabelPosition(clippedFrom, to.x - from.x, to.y - from.y)} text={edge.sourceCardinality} />
              )}
              {edge.lineStyle !== 'invisible' && edge.targetCardinality && (
                <UmlCardinalityLabel position={umlCardinalityLabelPosition(clippedTo, from.x - to.x, from.y - to.y)} text={edge.targetCardinality} />
              )}
              {/* Padded invisible hit-target rect, not a thin line: a horizontal or vertical
                  connector's own geometry has a zero-height/width bounding box, which is not a
                  reliable click (or double-click) target for a user or for automated testing. */}
              <rect
                x={Math.min(from.x, to.x) - 10}
                y={Math.min(from.y, to.y) - 10}
                // canvas-7vs.1: a self-message's hit target must cover its loop's visible extent
                // (to the right and below `from`), not just the zero-size from===to point.
                width={(isSequenceSelfMessage ? SELF_MESSAGE_LOOP_WIDTH : Math.max(Math.abs(to.x - from.x), 1)) + 20}
                height={(isSequenceSelfMessage ? 20 : Math.max(Math.abs(to.y - from.y), 1)) + 20}
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
                  () => {
                    setStylingEdgeId(null);
                    setEditingEdgeId(edge.id);
                  },
                  `Edit label for connector ${edge.id}`,
                )}
              {!isEditingThisEdge &&
                !connectMode &&
                hoveredId === edge.id &&
                renderStyleAffordance(
                  // Stacked directly above the pencil (same x range) rather than beside it: a
                  // horizontal offset here can land inside the adjacent node's own rect for the
                  // common close-together layout every canvas e2e spec uses, making the button
                  // unclickable (nodes paint on top of edges). Vertical stacking never extends
                  // the affordance cluster's x-range at all, so it can't introduce that collision.
                  edge.id,
                  midX + 8,
                  midY - 52,
                  () => {
                    setEditingEdgeId(null);
                    setStylingEdgeId(edge.id);
                  },
                  `Choose connector color for ${edge.id}`,
                )}
              {stylingEdgeId === edge.id &&
                renderStylePopup(
                  edge.id,
                  stylePopupPos.x,
                  stylePopupPos.y,
                  edge.style?.strokeColor,
                  (color) => onChange(updateEdgeStyle(model, edge.id, { strokeColor: color })),
                  () => onChange(updateEdgeStyle(model, edge.id, { strokeColor: null })),
                  () => setStylingEdgeId(null),
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

        {model.nodes.map((rawNode) => {
          // canvas-7vs.1: a sequence-diagram participant's header box is positioned at its
          // computed lifeline column instead of the placeholder node.position (research.md §1) —
          // shadowing `node` here (rather than a parallel variable) means every existing read
          // below — renderNodeShape, label editing, style popup, edit affordance — picks it up
          // for free. `rawNode` (the real model object) is used only where the real id/fields
          // matter for a state-mutating handler.
          const lifeline = sequenceLayout?.lifelines.get(rawNode.id);
          const node = lifeline
            ? { ...rawNode, position: { x: lifeline.headerX, y: lifeline.headerY }, size: { width: lifeline.headerWidth, height: lifeline.headerHeight } }
            : rawNode;
          const size = nodeSize(node);
          // canvas-xig: below the node (matching the original placement), clamped/flipped by
          // popupPosition so it never renders past the canvas's own edges for a node placed near
          // the border (research note on popupPosition).
          const stylePopupPos = popupPosition(node.position.y, node.position.y + size.height, node.position.x, canvasWidth, canvasHeight);
          // canvas-vcv: same below-the-node placement precedent as stylePopupPos, just with the
          // fields popup's own larger width/height.
          const fieldsPopupPos = popupPosition(
            node.position.y,
            node.position.y + size.height,
            node.position.x,
            canvasWidth,
            canvasHeight,
            FIELDS_POPUP_WIDTH,
            FIELDS_POPUP_HEIGHT,
          );
          // canvas-23t.5: mirrors svg-renderer.ts's renderNode icon branch exactly — glyph
          // top-aligned, caption stacked below it, both from the shared iconNodeLayout
          // calculation, so canvas and export agree (SC-004).
          const iconMarkup =
            node.shape === 'icon' && node.icon
              ? iconArtwork.get(`${node.icon.libraryId}@${node.icon.libraryVersion}@${node.icon.iconId}`)
              : undefined;
          const iconLayout = iconMarkup ? iconNodeLayout(node) : null;
          // canvas-x66: mirrors svg-renderer.ts's renderNode table branch exactly — header band
          // over a divider, one row below it per ER attribute/UML member, both from the shared
          // tableNodeLayout calculation, so canvas and export agree (SC-004).
          const tableLayout = tableNodeLayout(node);
          return (
            <g
              key={node.id}
              data-testid={`node-${node.id}`}
              onPointerDown={handleNodePointerDown(rawNode)}
              onPointerEnter={() => setHoveredId(node.id)}
              onPointerLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setEditingNodeId(node.id);
              }}
              style={{ cursor: connectMode ? 'crosshair' : lifeline ? 'default' : 'move' }}
            >
              {/* canvas-7vs.1: the vertical lifeline itself, drawn behind the header box. */}
              {lifeline && (
                <line x1={lifeline.x} y1={lifeline.top} x2={lifeline.x} y2={lifeline.bottom} stroke="#888888" strokeDasharray="4,2" />
              )}
              {renderNodeShape(node, selectedIds.has(node.id))}
              {iconMarkup && iconLayout && (
                <image
                  x={iconLayout.iconX}
                  y={iconLayout.iconY}
                  width={iconLayout.iconSize}
                  height={iconLayout.iconSize}
                  href={iconMarkupToDataUri(iconMarkup)}
                />
              )}
              {tableLayout && (
                <>
                  <line
                    x1={node.position.x}
                    y1={tableLayout.dividerY}
                    x2={node.position.x + size.width}
                    y2={tableLayout.dividerY}
                    stroke={node.style?.strokeColor ?? '#333333'}
                  />
                  {tableLayout.stereotype && (
                    <text
                      x={tableLayout.stereotype.x}
                      y={tableLayout.stereotype.y}
                      textAnchor="middle"
                      fontSize={tableLayout.stereotype.fontSize}
                    >
                      {tableLayout.stereotype.text}
                    </text>
                  )}
                  {tableLayout.rows.map((row, i) => (
                    <text key={i} x={row.x} y={row.y} dominantBaseline="middle" fontSize={row.fontSize}>
                      {row.text}
                    </text>
                  ))}
                </>
              )}
              {editingNodeId !== node.id &&
                (iconMarkup && iconLayout
                  ? renderLabelLines(
                      iconLayout.labelX,
                      iconLayout.labelY,
                      node.label,
                      iconLayout.labelFontSize,
                      false,
                      iconLayout.labelMaxWidth,
                    )
                  : tableLayout
                    ? renderLabelLines(
                        tableLayout.headerX,
                        tableLayout.headerY,
                        node.label,
                        tableLayout.headerFontSize,
                        true,
                        Math.max(size.width - 16, 40),
                      )
                    : renderLabelLines(
                        node.position.x + size.width / 2,
                        node.position.y + size.height / 2,
                        node.label,
                        14,
                        true,
                        Math.max(size.width - 16, 40),
                      ))}
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
                  () => {
                    setStylingNodeId(null);
                    setEditingFieldsNodeId(null);
                    setEditingNodeId(node.id);
                  },
                  `Edit label for ${node.label}`,
                )}
              {editingNodeId !== node.id &&
                !connectMode &&
                (hoveredId === node.id || selectedIds.has(node.id)) &&
                renderStyleAffordance(
                  node.id,
                  node.position.x + size.width - 50,
                  node.position.y + 2,
                  () => {
                    setEditingNodeId(null);
                    setEditingFieldsNodeId(null);
                    setStylingNodeId(node.id);
                  },
                  `Choose fill color for ${node.label}`,
                )}
              {stylingNodeId === node.id &&
                renderStylePopup(
                  node.id,
                  stylePopupPos.x,
                  stylePopupPos.y,
                  node.style?.fillColor,
                  (color) => onChange(updateNodeStyle(model, node.id, { fillColor: color })),
                  () => onChange(updateNodeStyle(model, node.id, { fillColor: null })),
                  () => setStylingNodeId(null),
                )}
              {/* canvas-vcv: every node in an ERD diagram is an entity (attributes); every node in
                  a UML diagram is a class (members) — there is no other node kind in either family
                  today, so this is gated on dslFamily alone, not on whether the node already has
                  any rows (a brand-new entity/class starts with none, which is exactly when this
                  affordance matters most). */}
              {editingNodeId !== node.id &&
                !connectMode &&
                (dslFamily === 'erd' || dslFamily === 'uml') &&
                (hoveredId === node.id || selectedIds.has(node.id)) &&
                renderFieldsAffordance(
                  node.id,
                  node.position.x + size.width - 76,
                  node.position.y + 2,
                  () => {
                    setEditingNodeId(null);
                    setStylingNodeId(null);
                    setEditingFieldsNodeId(node.id);
                  },
                  dslFamily === 'erd' ? `Edit attributes for ${node.label}` : `Edit members for ${node.label}`,
                )}
              {editingFieldsNodeId === node.id && (
                <FieldsPopup
                  node={node}
                  model={model}
                  dslFamily={dslFamily}
                  x={fieldsPopupPos.x}
                  y={fieldsPopupPos.y}
                  onChange={onChange}
                  onClose={() => setEditingFieldsNodeId(null)}
                />
              )}
            </g>
          );
        })}

        {/* canvas-558: live marquee-select rectangle, drawn on top of everything else and
            non-interactive so it never itself becomes a hit-test target mid-drag. */}
        {marqueeRect && (
          <rect
            data-testid="selection-marquee"
            x={marqueeRect.x}
            y={marqueeRect.y}
            width={marqueeRect.width}
            height={marqueeRect.height}
            fill="rgba(37, 99, 235, 0.08)"
            stroke={SELECTION_STROKE}
            strokeDasharray="4 2"
            pointerEvents="none"
          />
        )}
      </svg>
    </div>
  );
}
