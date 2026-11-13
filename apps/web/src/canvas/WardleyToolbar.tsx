// canvas-4h1j.2: the Wardley map tools in the editor rail. Add an element (it lands on a free spot; drag it where
// it belongs), and edit the selected one: its name (names stay distinct -- Mermaid reads two components with one
// name as one), where it sits ([visibility, evolution], shown), a component's strategy, inertia and evolve
// target, its pipeline; or the selected link's flow, line and label. Every change goes through diagram-core's
// Wardley edits (model/wardley-ops.ts), which the AI chat uses too.
import { useState } from 'react';
import {
  addWardleyElement,
  addWardleyPipelineComponent,
  setWardleyLinkFlow,
  setWardleyMarkings,
  updateEdgeArrowStyle,
  updateEdgeLabel,
  updateNodeLabel,
  wardleyCoordinatesAt,
  wardleyFrame,
  wardleyNameTaken,
  wardleyPercent,
  WARDLEY_STRATEGIES,
  type DiagramModel,
  type DiagramNode,
  type WardleyElementKind,
  type WardleyFlow,
  type WardleyStrategy,
} from '@canvas/diagram-core';

const ELEMENTS: { kind: WardleyElementKind; label: string; title: string }[] = [
  { kind: 'component', label: 'Component', title: 'Add a component: something the user need depends on' },
  { kind: 'anchor', label: 'Anchor', title: 'Add an anchor: a user or user need, at the top of the map' },
  { kind: 'note', label: 'Note', title: 'Add a note' },
  { kind: 'annotation', label: 'Annotation', title: 'Add a numbered annotation' },
  { kind: 'accelerator', label: 'Accelerator', title: 'Add an accelerator: something pushing evolution forward' },
  { kind: 'deaccelerator', label: 'Deaccelerator', title: 'Add a deaccelerator: something holding evolution back' },
];

const STRATEGY_LABELS: Record<WardleyStrategy, string> = { build: 'Build', buy: 'Buy', outsource: 'Outsource', market: 'Market' };
const FLOW_LABELS: { value: WardleyFlow | ''; label: string }[] = [
  { value: '', label: 'None' },
  { value: '+>', label: 'Forward (→)' },
  { value: '+<', label: 'Back (←)' },
  { value: '+<>', label: 'Both ways (↔)' },
];
const KIND_NAMES: Record<string, string> = {
  anchor: 'Anchor',
  component: 'Component',
  'pipeline-component': 'Pipeline component',
  note: 'Note',
  annotation: 'Annotation',
  accelerator: 'Accelerator',
  deaccelerator: 'Deaccelerator',
};

export interface WardleyToolbarProps {
  model: DiagramModel;
  selectedIds: Set<string>;
  selectedEdgeId: string | null;
  onChange: (model: DiagramModel) => void;
  /** Select the element just added. */
  onSelect: (id: string) => void;
}

const two = (value: number) => (Math.round(value * 100) / 100).toFixed(2);

function ElementPanel({ model, node, onChange, onSelect }: { model: DiagramModel; node: DiagramNode; onChange: (m: DiagramModel) => void; onSelect: (id: string) => void }) {
  const [name, setName] = useState(node.label);
  const [evolve, setEvolve] = useState(node.wardley?.evolve !== undefined ? String(node.wardley.evolve) : '');
  const [notice, setNotice] = useState<string | null>(null);
  const role = node.role ?? 'component';
  const isComponent = role === 'component' || role === 'pipeline-component';
  const inPipeline = role === 'pipeline-component';
  const point = node.wardley ?? wardleyCoordinatesAt(wardleyFrame(model), node.position);

  const commitName = () => {
    const label = name.trim();
    if (label === node.label) return;
    if (!label) {
      setName(node.label);
      return;
    }
    if (wardleyNameTaken(model, node.id, label)) {
      setNotice(`There is already a component named "${label}". Names must be different.`);
      return;
    }
    setNotice(null);
    onChange(updateNodeLabel(model, node.id, label));
  };
  const commitEvolve = () => {
    const text = evolve.trim();
    if (text === '') {
      if (node.wardley?.evolve !== undefined) onChange(setWardleyMarkings(model, node.id, { evolve: null }));
      setNotice(null);
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      setNotice('Evolve to a place on the evolution axis, from 0 to 1 (such as 0.8).');
      return;
    }
    setNotice(null);
    if (value !== node.wardley?.evolve) onChange(setWardleyMarkings(model, node.id, { evolve: value }));
  };

  return (
    <div className="stack" data-testid="wardley-selected">
      <p className="section-label rail-section__label">Selected: {KIND_NAMES[role] ?? 'Element'}</p>
      <label className="field__label" htmlFor="wardley-name">
        {role === 'note' || role === 'annotation' ? 'Text' : 'Name'}
        <input
          id="wardley-name"
          data-testid="wardley-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            if (e.key === 'Escape') setName(node.label);
            e.stopPropagation();
          }}
        />
      </label>
      <p className="canvas-notice" data-testid="wardley-coordinates">
        {inPipeline ? `Evolution ${two(wardleyPercent(point.evolution) / 100)}` : `Visibility ${two(wardleyPercent(point.visibility) / 100)} · Evolution ${two(wardleyPercent(point.evolution) / 100)}`}
      </p>
      {/* A pipeline component's line in the text has no strategy or inertia; it can have an evolve arrow. */}
      {role === 'component' && (
        <>
          <label className="field__label" htmlFor="wardley-strategy">
            Strategy
            <select
              id="wardley-strategy"
              data-testid="wardley-strategy"
              value={node.wardley?.strategy ?? ''}
              onChange={(e) => onChange(setWardleyMarkings(model, node.id, { strategy: (e.target.value || null) as WardleyStrategy | null }))}
            >
              <option value="">None</option>
              {WARDLEY_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {STRATEGY_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="cluster cluster--tight">
            <input
              type="checkbox"
              data-testid="wardley-inertia"
              checked={node.wardley?.inertia ?? false}
              onChange={(e) => onChange(setWardleyMarkings(model, node.id, { inertia: e.target.checked }))}
            />
            Inertia (resists change)
          </label>
        </>
      )}
      {isComponent && (
        <>
          <label className="field__label" htmlFor="wardley-evolve">
            Evolves to (0 to 1, empty for none)
            <input
              id="wardley-evolve"
              data-testid="wardley-evolve"
              inputMode="decimal"
              value={evolve}
              placeholder="such as 0.8"
              onChange={(e) => setEvolve(e.target.value)}
              onBlur={commitEvolve}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEvolve();
                e.stopPropagation();
              }}
            />
          </label>
        </>
      )}
      {role === 'component' && (
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="wardley-add-pipeline-component"
          title="Add a component to this component's pipeline: the forms it comes in, along the evolution axis"
          onClick={() => {
            const next = addWardleyPipelineComponent(model, node.id);
            onChange(next);
            onSelect(next.nodes[next.nodes.length - 1].id);
          }}
        >
          Add to pipeline
        </button>
      )}
      {notice && (
        <p className="canvas-notice" role="alert" data-testid="wardley-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

function LinkPanel({ model, edgeId, onChange }: { model: DiagramModel; edgeId: string; onChange: (m: DiagramModel) => void }) {
  const edge = model.edges.find((e) => e.id === edgeId);
  const [label, setLabel] = useState(edge?.label ?? '');
  if (!edge) return null;
  const data = edge.wardley;
  const flow = data?.flowArrow?.flow ?? data?.fromPort ?? data?.toPort ?? '';
  const commitLabel = () => {
    const text = label.replace(/[\r\n]+/g, ' ').trim();
    if (text !== (edge.label ?? '')) onChange(updateEdgeLabel(model, edge.id, text));
  };
  return (
    <div className="stack" data-testid="wardley-selected-link">
      <p className="section-label rail-section__label">Selected: Link</p>
      <label className="field__label" htmlFor="wardley-link-flow">
        Flow
        <select
          id="wardley-link-flow"
          data-testid="wardley-link-flow"
          value={flow}
          onChange={(e) => onChange(setWardleyLinkFlow(model, edge.id, (e.target.value || null) as WardleyFlow | null))}
        >
          {FLOW_LABELS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label className="cluster cluster--tight">
        <input
          type="checkbox"
          data-testid="wardley-link-dotted"
          checked={edge.lineStyle === 'dotted'}
          onChange={(e) => onChange(updateEdgeArrowStyle(model, edge.id, { lineStyle: e.target.checked ? 'dotted' : null }))}
        />
        Dotted line
      </label>
      <label className="field__label" htmlFor="wardley-link-label">
        Label
        <input
          id="wardley-link-label"
          data-testid="wardley-link-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLabel();
            e.stopPropagation();
          }}
        />
      </label>
    </div>
  );
}

export function WardleyToolbar({ model, selectedIds, selectedEdgeId, onChange, onSelect }: WardleyToolbarProps) {
  const selected = selectedIds.size === 1 ? model.nodes.find((n) => selectedIds.has(n.id)) : undefined;
  return (
    <div className="rail-section" data-testid="wardley-toolbar">
      <p className="section-label rail-section__label">Map elements</p>
      <div className="tool-list">
        {ELEMENTS.map(({ kind, label, title }) => (
          <button
            key={kind}
            type="button"
            className="btn btn--secondary"
            data-testid={`add-wardley-${kind}`}
            title={title}
            onClick={() => {
              const next = addWardleyElement(model, { kind });
              onChange(next);
              onSelect(next.nodes[next.nodes.length - 1].id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {selected && <ElementPanel key={`${selected.id}:${selected.label}:${selected.wardley?.evolve ?? ''}`} model={model} node={selected} onChange={onChange} onSelect={onSelect} />}
      {!selected && selectedEdgeId && <LinkPanel key={selectedEdgeId} model={model} edgeId={selectedEdgeId} onChange={onChange} />}
    </div>
  );
}
