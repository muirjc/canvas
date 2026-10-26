import {
  computeLegendEntries,
  type DiagramLegend,
  type DiagramModel,
  type LegendEntrySpec,
  type LegendSample,
  type NodeShape,
  type StandardRules,
} from '@canvas/diagram-core';
import { Modal } from '../ui/Modal';
import { getAddableShapes } from './shapes';

type LineStyle = NonNullable<Extract<LegendSample, { kind: 'line' }>['lineStyle']>;
type Arrow = NonNullable<Extract<LegendSample, { kind: 'line' }>['arrow']>;

const LINE_STYLES: LineStyle[] = ['solid', 'dotted', 'thick'];
const ARROWS: { value: Arrow; label: string }[] = [
  { value: 'target', label: 'Forward' },
  { value: 'source', label: 'Reversed' },
  { value: 'both', label: 'Both ends' },
  { value: 'none', label: 'No arrowhead' },
];

export interface LegendEditorProps {
  model: DiagramModel;
  dslFamily: string;
  standardRules?: StandardRules;
  onChange: (model: DiagramModel) => void;
  onClose: () => void;
}

/** Drops empty collections so the front-matter stays tidy. */
function tidy(legend: DiagramLegend): DiagramLegend {
  const next = { ...legend };
  if (!next.title) delete next.title;
  if (next.hidden && next.hidden.length === 0) delete next.hidden;
  if (next.labels && Object.keys(next.labels).length === 0) delete next.labels;
  if (next.extra && next.extra.length === 0) delete next.extra;
  return next;
}

/**
 * canvas-ltk: the legend editor -- title, which automatic entries show (and under what label), and
 * the author's own entries. Every change goes straight to `onChange`, like any other canvas edit.
 */
export function LegendEditor({ model, dslFamily, standardRules, onChange, onClose }: LegendEditorProps) {
  const legend: DiagramLegend = model.legend ?? { visible: true };
  const update = (patch: Partial<DiagramLegend>) => onChange({ ...model, legend: tidy({ ...legend, ...patch }) });

  // Every automatic entry, including hidden ones (so they can be shown again) and unrenamed.
  const automatic = computeLegendEntries({ ...model, legend: { visible: true } }, standardRules).filter((e) => e.automatic);
  const hidden = new Set(legend.hidden ?? []);
  const extras = legend.extra ?? [];
  const shapes = getAddableShapes(dslFamily);

  const setExtra = (index: number, patch: Partial<LegendEntrySpec>) =>
    update({ extra: extras.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  const setSample = (index: number, sample: LegendSample) => setExtra(index, { sample });

  const addEntry = () => {
    // The next unused e<n>: unique within this legend, which is all an id needs to be.
    const taken = new Set(extras.map((e) => e.id));
    let n = extras.length + 1;
    while (taken.has(`e${n}`)) n++;
    const id = `e${n}`;
    const shape: NodeShape = shapes[0]?.shape ?? 'rectangle';
    update({ extra: [...extras, { id, label: 'New entry', sample: { kind: 'shape', shape } }] });
  };

  const colorInput = (testId: string, label: string, value: string | undefined, fallback: string, onPick: (hex: string | undefined) => void) => (
    <span className="legend-editor__row">
      <label className="field__label">
        {label}
        <input type="color" data-testid={testId} value={value ?? fallback} onChange={(e) => onPick(e.target.value)} />
      </label>
      {value && (
        <button type="button" className="btn btn--secondary" onClick={() => onPick(undefined)} aria-label={`Clear ${label.toLowerCase()}`}>
          Clear
        </button>
      )}
    </span>
  );

  return (
    <Modal
      label="Edit legend"
      title="Edit legend"
      wide
      testId="legend-editor"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn--primary" data-testid="legend-done" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="stack">
        <label className="field">
          <span className="field__label">Title</span>
          <input
            type="text"
            data-testid="legend-title"
            value={legend.title ?? ''}
            placeholder="Legend"
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>

        <section aria-labelledby="legend-auto-heading" className="stack">
          <h3 id="legend-auto-heading" className="section-label">Standard entries</h3>
          {!standardRules && (
            <p className="muted" data-testid="legend-no-standard">
              No standard for this diagram type -- only your own entries appear.
            </p>
          )}
          {standardRules && automatic.length === 0 && (
            <p className="muted">Entries appear here once the diagram uses an element kind or connector from the standard.</p>
          )}
          {automatic.map((entry) => {
            const labels = { ...(legend.labels ?? {}) };
            return (
              <div key={entry.key} className="legend-editor__row">
                <label className="legend-editor__row">
                  <input
                    type="checkbox"
                    data-testid={`legend-auto-${entry.key}-show`}
                    checked={!hidden.has(entry.key)}
                    onChange={(e) =>
                      update({ hidden: e.target.checked ? [...hidden].filter((k) => k !== entry.key) : [...hidden, entry.key] })
                    }
                  />
                  Show
                </label>
                <input
                  type="text"
                  data-testid={`legend-auto-${entry.key}-label`}
                  aria-label={`Label for ${entry.key.split(':')[1]}`}
                  value={legend.labels?.[entry.key] ?? ''}
                  placeholder={entry.label}
                  onChange={(e) => {
                    if (e.target.value === '') delete labels[entry.key];
                    else labels[entry.key] = e.target.value;
                    update({ labels });
                  }}
                />
              </div>
            );
          })}
        </section>

        <section aria-labelledby="legend-extra-heading" className="stack">
          <h3 id="legend-extra-heading" className="section-label">Your entries</h3>
          {extras.map((extra, n) => (
            <div key={extra.id} className="legend-editor__entry" data-testid={`legend-extra-${n}`}>
              <div className="legend-editor__row">
                <input
                  type="text"
                  data-testid={`legend-extra-${n}-label`}
                  aria-label={`Label for entry ${n + 1}`}
                  value={extra.label}
                  onChange={(e) => setExtra(n, { label: e.target.value })}
                />
                <select
                  data-testid={`legend-extra-${n}-type`}
                  aria-label={`Sample type for entry ${n + 1}`}
                  value={extra.sample.kind}
                  onChange={(e) =>
                    setSample(n, e.target.value === 'line' ? { kind: 'line', lineStyle: 'solid', arrow: 'target' } : { kind: 'shape', shape: shapes[0]?.shape ?? 'rectangle' })
                  }
                >
                  <option value="shape">Shape</option>
                  <option value="line">Line</option>
                </select>
                <button type="button" className="btn btn--secondary" data-testid={`legend-extra-${n}-remove`} onClick={() => update({ extra: extras.filter((_, i) => i !== n) })}>
                  Remove
                </button>
              </div>
              {extra.sample.kind === 'shape' ? (
                (() => {
                  const sample = extra.sample;
                  return (
                    <div className="legend-editor__row">
                      <label className="field__label">
                        Shape
                        <select data-testid={`legend-extra-${n}-shape`} value={sample.shape} onChange={(e) => setSample(n, { ...sample, shape: e.target.value as NodeShape })}>
                          {!shapes.some((s) => s.shape === sample.shape) && <option value={sample.shape}>{sample.shape}</option>}
                          {shapes.map((s) => (
                            <option key={s.shape} value={s.shape}>{s.label}</option>
                          ))}
                        </select>
                      </label>
                      {colorInput(`legend-extra-${n}-fill`, 'Fill', sample.fill, '#ffffff', (fill) => {
                        const { fill: _drop, ...rest } = sample;
                        setSample(n, fill ? { ...rest, fill } : rest);
                      })}
                      {colorInput(`legend-extra-${n}-stroke`, 'Stroke', sample.stroke, '#333333', (stroke) => {
                        const { stroke: _drop, ...rest } = sample;
                        setSample(n, stroke ? { ...rest, stroke } : rest);
                      })}
                    </div>
                  );
                })()
              ) : (
                (() => {
                  const sample = extra.sample;
                  return (
                    <div className="legend-editor__row">
                      <label className="field__label">
                        Line
                        <select data-testid={`legend-extra-${n}-linestyle`} value={sample.lineStyle ?? 'solid'} onChange={(e) => setSample(n, { ...sample, lineStyle: e.target.value as LineStyle })}>
                          {LINE_STYLES.map((s) => (
                            <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field__label">
                        Arrow
                        <select data-testid={`legend-extra-${n}-arrow`} value={sample.arrow ?? 'target'} onChange={(e) => setSample(n, { ...sample, arrow: e.target.value as Arrow })}>
                          {ARROWS.map((a) => (
                            <option key={a.value} value={a.value}>{a.label}</option>
                          ))}
                        </select>
                      </label>
                      {colorInput(`legend-extra-${n}-stroke`, 'Colour', sample.stroke, '#333333', (stroke) => {
                        const { stroke: _drop, ...rest } = sample;
                        setSample(n, stroke ? { ...rest, stroke } : rest);
                      })}
                    </div>
                  );
                })()
              )}
            </div>
          ))}
          <div>
            <button type="button" className="btn btn--secondary" data-testid="legend-add-entry" onClick={addEntry}>
              Add entry
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
