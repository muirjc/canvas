import { useMemo, useState } from 'react';
import {
  C4_BOUNDARY_ROLES,
  C4_ELEMENT_ROLES,
  DEFAULT_SEVERITY,
  FAMILY_NODE_SHAPES,
  FAMILY_SUPPORTS_ELEMENT_KINDS,
  RULE_IDS,
  checkStandardDefinition,
  emptyStandardRules,
  type ConnectorRule,
  type ElementKind,
  type RuleId,
  type Severity,
  type StandardRules,
} from '@canvas/diagram-core';
import { api, ApiError, type DiagramTypeDto, type StandardDto } from '../app/api';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LINE_STYLES = ['solid', 'dotted', 'thick'] as const;
const ARROWS = [
  { value: 'target', label: 'Arrow at target' },
  { value: 'none', label: 'No arrowhead' },
  { value: 'both', label: 'Both ends' },
  { value: 'source', label: 'Arrow at source' },
] as const;
const SEVERITY_LABEL: Record<Severity, string> = { error: 'Must fix', warning: 'Warning', info: 'Info' };

const snake = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]+/, '');

interface Issue {
  path: string;
  message: string;
}

export interface StandardsEditorProps {
  diagramType: DiagramTypeDto;
  /** An existing draft to edit; omit to author a new one. */
  standard?: StandardDto;
  onDone: (message: string) => void;
  onCancel: () => void;
}

/** Remove empty optional fields so the stored rules stay minimal. */
function cleanRules(rules: StandardRules, family: string): StandardRules {
  const out: StandardRules = { ...rules };
  out.guidance = rules.guidance?.trim() ? rules.guidance : undefined;
  if (rules.elementKinds) {
    out.elementKinds = rules.elementKinds.map((kind) => {
      const k: ElementKind = { ...kind, description: kind.description?.trim() || undefined };
      if (!k.approvedStrokes?.length) delete k.approvedStrokes;
      if (family !== 'c4') delete k.match;
      if (k.match && !k.match.external) k.match = { role: k.match.role };
      return k;
    });
  }
  return out;
}

/**
 * Authoring screen for one Standard (a draft) of one diagram type: element kinds, connector rules,
 * groupings, strictness and the legacy v1 rules. Definition problems are shown inline before save.
 */
export function StandardsEditor({ diagramType, standard, onDone, onCancel }: StandardsEditorProps) {
  const family = diagramType.dslFamily;
  const supportsKinds = FAMILY_SUPPORTS_ELEMENT_KINDS.has(family);
  const familyShapes: readonly string[] = FAMILY_NODE_SHAPES[family] ?? FAMILY_NODE_SHAPES.flowchart;
  const isC4 = family === 'c4';

  const [name, setName] = useState(standard?.name ?? '');
  const [description, setDescription] = useState(standard?.description ?? '');
  const [rules, setRules] = useState<StandardRules>(() => standard?.rules ?? emptyStandardRules());
  const [savedStandard, setSavedStandard] = useState<StandardDto | undefined>(standard);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [busy, setBusy] = useState(false);

  const kinds = rules.elementKinds ?? [];
  const connectors = rules.connectorRules ?? [];

  const patch = (next: Partial<StandardRules>) => {
    setRules((prev) => ({ ...prev, ...next }));
    setSavedNote(null);
  };
  const patchKind = (i: number, next: Partial<ElementKind>) =>
    patch({ elementKinds: kinds.map((k, idx) => (idx === i ? { ...k, ...next } : k)) });
  const patchConnector = (i: number, next: Partial<ConnectorRule>) =>
    patch({ connectorRules: connectors.map((c, idx) => (idx === i ? { ...c, ...next } : c)) });

  const cleaned = useMemo(() => cleanRules(rules, family), [rules, family]);
  const clientIssues = useMemo(() => checkStandardDefinition(cleaned, family), [cleaned, family]);
  const nameIssues: Issue[] = name.trim() ? [] : [{ path: 'name', message: 'Give the standard a name.' }];
  const issues: Issue[] = [...nameIssues, ...clientIssues, ...serverIssues.filter((s) => !clientIssues.some((c) => c.path === s.path && c.message === s.message))];
  const errs = (path: string) => issues.filter((issue) => issue.path === path);

  const FieldErrors = ({ path, id }: { path: string; id?: string }) => {
    const list = errs(path);
    if (list.length === 0) return null;
    return (
      <span className="field__error" id={id} data-testid={`error-${path}`}>
        {list.map((l) => l.message).join(' ')}
      </span>
    );
  };

  // ---- persistence -----------------------------------------------------------------
  const save = async (): Promise<StandardDto | null> => {
    setBusy(true);
    setSaveError(null);
    setServerIssues([]);
    try {
      const payload = { ...cleaned, name: name.trim(), description: description.trim() || null };
      const { standard: saved } = savedStandard
        ? await api.updateStandard(savedStandard.id, payload)
        : await api.createStandard(diagramType.id, payload);
      setSavedStandard(saved);
      return saved;
    } catch (error) {
      const details = error instanceof ApiError ? (error.details as { issues?: Issue[] } | undefined) : undefined;
      if (details?.issues?.length) setServerIssues(details.issues);
      setSaveError((error as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    const saved = await save();
    if (saved) setSavedNote(`Draft saved (v${saved.version}).`);
  };

  const publish = async () => {
    setConfirmPublish(false);
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      await api.publishStandard(saved.id);
      onDone(`Published standard v${saved.version} for ${diagramType.name}.`);
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- kinds ------------------------------------------------------------------------
  const addKind = () => {
    const taken = new Set(kinds.map((k) => k.id));
    let n = kinds.length + 1;
    while (taken.has(`kind_${n}`)) n += 1;
    const kind: ElementKind = { id: '', label: '', shapes: [], approvedFills: [] };
    if (isC4) kind.match = { role: 'system' };
    patch({ elementKinds: [...kinds, kind] });
  };
  const removeKind = (i: number) => {
    const removed = kinds[i]?.id;
    patch({
      elementKinds: kinds.filter((_, idx) => idx !== i),
      // Connector rules pointing at a removed kind would be invalid; reset those ends to "Any".
      connectorRules: connectors.map((c) => ({ ...c, from: c.from === removed ? '*' : c.from, to: c.to === removed ? '*' : c.to })),
    });
  };
  const setKindLabel = (i: number, label: string) => {
    const kind = kinds[i];
    const idFollows = kind.id === '' || kind.id === snake(kind.label);
    patchKind(i, idFollows ? { label, id: snake(label) } : { label });
  };

  const addConnector = () => {
    const taken = new Set(connectors.map((c) => c.id));
    let n = connectors.length + 1;
    while (taken.has(`connection_${n}`)) n += 1;
    patch({ connectorRules: [...connectors, { id: `connection_${n}`, label: '', from: '*', to: '*' }] });
  };

  const kindOptions = (
    <>
      <option value="*">Any element</option>
      {kinds.filter((k) => k.id).map((k) => (
        <option key={k.id} value={k.id}>
          {k.label || k.id}
        </option>
      ))}
    </>
  );

  const toggleIn = <T extends string>(list: T[] | undefined, value: T): T[] =>
    (list ?? []).includes(value) ? (list ?? []).filter((v) => v !== value) : [...(list ?? []), value];

  const containers = rules.containers ?? { allowed: true };
  const [roleDraft, setRoleDraft] = useState('');

  return (
    <div data-testid="standards-editor" className="stack">
      <div className="cluster">
        <button type="button" className="btn btn--tertiary btn--compact" data-testid="standard-back" onClick={onCancel}>
          <Icon name="chevron-right" className="icon--flip" /> Back to versions
        </button>
        <h2 className="spacer">
          {savedStandard ? `Edit draft v${savedStandard.version}` : 'New standard'} — {diagramType.name}
        </h2>
      </div>

      {issues.length > 0 && (
        <div role="alert" className="card std-summary" data-testid="standard-issues">
          <strong>
            {issues.length} problem{issues.length === 1 ? '' : 's'} to fix before saving
          </strong>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Basics ---- */}
      <section className="card std-section" aria-labelledby="std-basics">
        <h3 id="std-basics" className="section-label">Basics</h3>
        <div className="field">
          <label className="field__label" htmlFor="standard-name">Name</label>
          <input id="standard-name" data-testid="standard-name-input" value={name} placeholder="e.g. Value chain rules" onChange={(e) => { setName(e.target.value); setSavedNote(null); }} />
          <FieldErrors path="name" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="standard-description">Description</label>
          <textarea id="standard-description" data-testid="standard-description-input" rows={2} value={description} placeholder="What this standard is for" onChange={(e) => { setDescription(e.target.value); setSavedNote(null); }} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="standard-guidance">Guidance</label>
          <textarea id="standard-guidance" data-testid="standard-guidance-input" rows={3} value={rules.guidance ?? ''} onChange={(e) => patch({ guidance: e.target.value })} />
          <span className="meta">Free-text advice shown to authors and given to the AI assistant, e.g. “support activities sit above primary activities”.</span>
        </div>
      </section>

      {/* ---- Element kinds ---- */}
      <section className="card std-section" aria-labelledby="std-kinds">
        <h3 id="std-kinds" className="section-label">Element kinds</h3>
        {!supportsKinds ? (
          <p className="meta" data-testid="kinds-unsupported">
            {family} diagrams don’t support element kinds, so only the strictness, groupings and legacy rules below apply.
          </p>
        ) : (
          <>
            <p className="meta">Each kind is a named type of element (e.g. “Primary Activity”) with its own shapes and approved colors. The first shape and first color are the defaults.</p>
            {kinds.length === 0 && <p className="meta">No kinds defined yet.</p>}
            {kinds.map((kind, i) => (
              <KindCard
                key={i}
                index={i}
                kind={kind}
                isC4={isC4}
                familyShapes={familyShapes}
                onLabel={(label) => setKindLabel(i, label)}
                onPatch={(next) => patchKind(i, next)}
                onRemove={() => removeKind(i)}
                FieldErrors={FieldErrors}
              />
            ))}
            <button type="button" className="btn btn--secondary" data-testid="kind-add" onClick={addKind}>
              <Icon name="plus" /> Add element kind
            </button>
            <FieldErrors path="elementKinds" />
          </>
        )}
      </section>

      {/* ---- Connector rules ---- */}
      <section className="card std-section" aria-labelledby="std-connectors">
        <h3 id="std-connectors" className="section-label">Connector rules</h3>
        {!supportsKinds ? (
          <p className="meta">Connector rules relate element kinds, which {family} diagrams don’t support.</p>
        ) : (
          <>
            <label className="cluster cluster--tight">
              <input type="checkbox" data-testid="connector-policy" checked={rules.connectorPolicy === 'listed-only'} onChange={(e) => patch({ connectorPolicy: e.target.checked ? 'listed-only' : 'any' })} />
              Only listed connections allowed
            </label>
            <span className="meta">When off, connections that match no rule are not flagged.</span>
            {connectors.map((rule, i) => (
              <div key={i} className="std-item" data-testid={`connector-row-${i}`}>
                <div className="std-grid">
                  <div className="field">
                    <label className="field__label" htmlFor={`connector-label-${i}`}>Label</label>
                    <input id={`connector-label-${i}`} data-testid={`connector-label-${i}`} value={rule.label} onChange={(e) => patchConnector(i, { label: e.target.value })} />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`connector-from-${i}`}>From</label>
                    <select id={`connector-from-${i}`} data-testid={`connector-from-${i}`} value={rule.from} onChange={(e) => patchConnector(i, { from: e.target.value })}>{kindOptions}</select>
                    <FieldErrors path={`connectorRules[${i}].from`} />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`connector-to-${i}`}>To</label>
                    <select id={`connector-to-${i}`} data-testid={`connector-to-${i}`} value={rule.to} onChange={(e) => patchConnector(i, { to: e.target.value })}>{kindOptions}</select>
                    <FieldErrors path={`connectorRules[${i}].to`} />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`connector-max-${i}`}>Max per source</label>
                    <input id={`connector-max-${i}`} type="number" min={1} data-testid={`connector-max-${i}`} value={rule.maxPerSource ?? ''} onChange={(e) => patchConnector(i, { maxPerSource: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </div>
                </div>
                <div className="cluster">
                  <fieldset className="cluster cluster--tight std-fieldset">
                    <legend className="field__label">Line styles (first = default)</legend>
                    {LINE_STYLES.map((style) => (
                      <label key={style} className="cluster cluster--tight">
                        <input type="checkbox" data-testid={`connector-line-${i}-${style}`} checked={(rule.lineStyles ?? []).includes(style)} onChange={() => patchConnector(i, { lineStyles: toggleIn(rule.lineStyles, style) })} />
                        {style}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="cluster cluster--tight std-fieldset">
                    <legend className="field__label">Arrowheads (first = default)</legend>
                    {ARROWS.map((arrow) => (
                      <label key={arrow.value} className="cluster cluster--tight">
                        <input type="checkbox" data-testid={`connector-arrow-${i}-${arrow.value}`} checked={(rule.arrows ?? []).includes(arrow.value)} onChange={() => patchConnector(i, { arrows: toggleIn(rule.arrows, arrow.value) })} />
                        {arrow.label}
                      </label>
                    ))}
                  </fieldset>
                  <label className="cluster cluster--tight">
                    <input type="checkbox" data-testid={`connector-require-label-${i}`} checked={Boolean(rule.requireLabel)} onChange={(e) => patchConnector(i, { requireLabel: e.target.checked })} />
                    Require a label
                  </label>
                  <span className="spacer" />
                  <button type="button" className="btn btn--tertiary-danger btn--compact" data-testid={`connector-remove-${i}`} onClick={() => patch({ connectorRules: connectors.filter((_, idx) => idx !== i) })}>
                    Remove connection rule
                  </button>
                </div>
              </div>
            ))}
            <button type="button" className="btn btn--secondary" data-testid="connector-add" onClick={addConnector}>
              <Icon name="plus" /> Add connection rule
            </button>
          </>
        )}
      </section>

      {/* ---- Groupings ---- */}
      <section className="card std-section" aria-labelledby="std-groups">
        <h3 id="std-groups" className="section-label">Groupings</h3>
        <label className="cluster cluster--tight">
          <input type="checkbox" data-testid="containers-allowed" checked={containers.allowed} onChange={(e) => patch({ containers: { ...containers, allowed: e.target.checked } })} />
          Groupings (subgraphs, boundaries) are allowed
        </label>
        {containers.allowed && (
          isC4 ? (
            <fieldset className="cluster cluster--tight std-fieldset">
              <legend className="field__label">Allowed boundary kinds (none selected = all)</legend>
              {C4_BOUNDARY_ROLES.map((role) => (
                <label key={role} className="cluster cluster--tight">
                  <input type="checkbox" data-testid={`container-role-${role}`} checked={(containers.allowedRoles ?? []).includes(role)} onChange={() => patch({ containers: { ...containers, allowedRoles: toggleIn(containers.allowedRoles, role) } })} />
                  {role}
                </label>
              ))}
            </fieldset>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor="container-role-input">Allowed grouping roles (none = all)</label>
              <div className="cluster">
                {(containers.allowedRoles ?? []).map((role) => (
                  <span key={role} className="pill">
                    {role}{' '}
                    <button type="button" className="std-chip-x" aria-label={`Remove role ${role}`} onClick={() => patch({ containers: { ...containers, allowedRoles: (containers.allowedRoles ?? []).filter((r) => r !== role) } })}>×</button>
                  </span>
                ))}
                <input id="container-role-input" data-testid="container-role-input" value={roleDraft} onChange={(e) => setRoleDraft(e.target.value)} />
                <button type="button" className="btn btn--secondary btn--compact" data-testid="container-role-add" disabled={!roleDraft.trim()} onClick={() => { const r = roleDraft.trim(); const cur = containers.allowedRoles ?? []; if (!cur.includes(r)) patch({ containers: { ...containers, allowedRoles: [...cur, r] } }); setRoleDraft(''); }}>Add role</button>
              </div>
            </div>
          )
        )}
      </section>

      {/* ---- Strictness ---- */}
      <section className="card std-section" aria-labelledby="std-strict">
        <h3 id="std-strict" className="section-label">Strictness</h3>
        {supportsKinds && (
          <label className="cluster cluster--tight">
            <input type="checkbox" data-testid="require-known-kinds" checked={Boolean(rules.requireKnownKinds)} onChange={(e) => patch({ requireKnownKinds: e.target.checked })} />
            Every element must be one of these kinds
          </label>
        )}
        <p className="meta">How serious each kind of finding is. “Must fix” is highlighted prominently but never blocks saving.</p>
        <table className="std-table">
          <thead>
            <tr><th scope="col">Rule</th><th scope="col">Default</th><th scope="col">For this standard</th></tr>
          </thead>
          <tbody>
            {RULE_IDS.map((ruleId: RuleId) => (
              <tr key={ruleId}>
                <th scope="row"><code>{ruleId}</code></th>
                <td>{SEVERITY_LABEL[DEFAULT_SEVERITY[ruleId]]}</td>
                <td>
                  <select
                    aria-label={`Severity for ${ruleId}`}
                    data-testid={`severity-${ruleId}`}
                    value={rules.severityOverrides?.[ruleId] ?? ''}
                    onChange={(e) => {
                      const next = { ...(rules.severityOverrides ?? {}) };
                      if (e.target.value) next[ruleId] = e.target.value as Severity;
                      else delete next[ruleId];
                      patch({ severityOverrides: Object.keys(next).length ? next : undefined });
                    }}
                  >
                    <option value="">Default</option>
                    {(Object.keys(SEVERITY_LABEL) as Severity[]).map((s) => (
                      <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ---- Legacy ---- */}
      <details className="card std-section" data-testid="legacy-rules">
        <summary>Legacy rules (whole-diagram shapes and role colors)</summary>
        {(['allowedShapeIds', 'mandatoryShapeIds'] as const).map((field) => (
          <fieldset key={field} className="cluster cluster--tight std-fieldset">
            <legend className="field__label">
              {field === 'allowedShapeIds' ? 'Allowed shapes (none selected = unrestricted)' : 'Mandatory shapes (must appear at least once)'}
            </legend>
            {familyShapes.map((shape) => (
              <label key={shape} className="cluster cluster--tight" data-testid={`${field === 'allowedShapeIds' ? 'allowed' : 'mandatory'}-shape-${shape}`}>
                <input type="checkbox" checked={rules[field].includes(shape as never)} onChange={() => patch({ [field]: toggleIn(rules[field] as string[], shape) } as Partial<StandardRules>)} />
                {shape}
              </label>
            ))}
          </fieldset>
        ))}
        <h4 className="section-label">Approved color per role</h4>
        {rules.colorPalette.length === 0 && <p className="meta">None.</p>}
        <ul>
          {rules.colorPalette.map((entry, i) => (
            <li key={i} className="cluster">
              <span className="std-swatch" style={{ background: entry.colorHex }} aria-hidden="true" />
              {entry.role}: {entry.colorHex}
              <button type="button" className="btn btn--tertiary-danger btn--compact" data-testid={`palette-remove-${i}`} aria-label={`Remove color rule for ${entry.role}`} onClick={() => patch({ colorPalette: rules.colorPalette.filter((_, idx) => idx !== i) })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </details>

      {saveError && <p role="alert" className="field__error" data-testid="standard-save-error">{saveError}</p>}
      {savedNote && <p role="status" data-testid="standard-saved-note">{savedNote}</p>}

      <div className="cluster">
        <button type="button" className="btn btn--secondary" data-testid="standard-cancel" onClick={onCancel}>
          {savedStandard ? 'Close' : 'Cancel'}
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn--secondary" data-testid="standard-save" disabled={issues.length > 0 || busy} onClick={saveDraft}>
          Save draft
        </button>
        <button type="button" className="btn btn--primary" data-testid="standard-publish" disabled={issues.length > 0 || busy} onClick={() => setConfirmPublish(true)}>
          Publish
        </button>
      </div>

      {confirmPublish && (
        <Modal
          role="alertdialog"
          label="Publish standard"
          testId="standard-publish-confirm"
          onClose={() => setConfirmPublish(false)}
          footer={
            <>
              <button type="button" className="btn btn--secondary" data-testid="standard-publish-cancel" onClick={() => setConfirmPublish(false)}>Cancel</button>
              <button type="button" className="btn btn--primary" data-testid="standard-publish-confirm-button" onClick={publish}>Save and publish</button>
            </>
          }
        >
          <p>
            Publishing saves this draft and makes it the active standard for {diagramType.name}. Any previously
            published standard is retired, and existing diagrams of this type will be re-checked against the new rules.
          </p>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------

interface KindCardProps {
  index: number;
  kind: ElementKind;
  isC4: boolean;
  familyShapes: readonly string[];
  onLabel: (label: string) => void;
  onPatch: (next: Partial<ElementKind>) => void;
  onRemove: () => void;
  FieldErrors: (props: { path: string; id?: string }) => JSX.Element | null;
}

function KindCard({ index: i, kind, isC4, familyShapes, onLabel, onPatch, onRemove, FieldErrors }: KindCardProps) {
  const at = `elementKinds[${i}]`;
  const toggleShape = (shape: string) =>
    onPatch({ shapes: (kind.shapes as string[]).includes(shape) ? kind.shapes.filter((s) => s !== shape) : [...kind.shapes, shape as ElementKind['shapes'][number]] });
  const makeDefaultShape = (shape: string) =>
    onPatch({ shapes: [shape as ElementKind['shapes'][number], ...kind.shapes.filter((s) => s !== shape)] });
  const num = (value: string) => (value === '' ? undefined : Number(value));

  return (
    <div className="std-item" data-testid={`kind-row-${i}`} role="group" aria-label={`Element kind ${kind.label || i + 1}`}>
      <div className="std-grid">
        <div className="field">
          <label className="field__label" htmlFor={`kind-label-${i}`}>Label</label>
          <input id={`kind-label-${i}`} data-testid={`kind-label-${i}`} value={kind.label} onChange={(e) => onLabel(e.target.value)} />
          <FieldErrors path={`${at}.label`} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`kind-id-${i}`}>Id</label>
          <input id={`kind-id-${i}`} data-testid={`kind-id-${i}`} className="mono" value={kind.id} onChange={(e) => onPatch({ id: e.target.value })} />
          <FieldErrors path={`${at}.id`} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`kind-min-${i}`}>Min count</label>
          <input id={`kind-min-${i}`} type="number" min={0} data-testid={`kind-min-${i}`} value={kind.minCount ?? ''} onChange={(e) => onPatch({ minCount: num(e.target.value) })} />
          <FieldErrors path={`${at}.minCount`} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`kind-max-${i}`}>Max count</label>
          <input id={`kind-max-${i}`} type="number" min={0} data-testid={`kind-max-${i}`} value={kind.maxCount ?? ''} onChange={(e) => onPatch({ maxCount: num(e.target.value) })} />
        </div>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`kind-desc-${i}`}>Description</label>
        <input id={`kind-desc-${i}`} data-testid={`kind-desc-${i}`} value={kind.description ?? ''} onChange={(e) => onPatch({ description: e.target.value })} />
      </div>

      <fieldset className="cluster cluster--tight std-fieldset">
        <legend className="field__label">Shapes (none = any; first is the default)</legend>
        {familyShapes.map((shape) => {
          const pos = (kind.shapes as string[]).indexOf(shape);
          return (
            <span key={shape} className="cluster cluster--tight">
              <label className="cluster cluster--tight">
                <input type="checkbox" data-testid={`kind-shape-${i}-${shape}`} checked={pos >= 0} onChange={() => toggleShape(shape)} />
                {shape}
              </label>
              {pos === 0 && <span className="pill">default</span>}
              {pos > 0 && (
                <button type="button" className="btn btn--tertiary btn--compact" aria-label={`Make ${shape} the default shape`} onClick={() => makeDefaultShape(shape)}>
                  Make default
                </button>
              )}
            </span>
          );
        })}
      </fieldset>
      <FieldErrors path={`${at}.shapes`} />

      <Swatches
        label="Approved fills (first is the default)"
        testId={`kind-fill-${i}`}
        values={kind.approvedFills}
        onChange={(approvedFills) => onPatch({ approvedFills })}
      />
      <FieldErrors path={`${at}.approvedFills`} />
      <Swatches
        label="Approved strokes (optional)"
        testId={`kind-stroke-${i}`}
        values={kind.approvedStrokes ?? []}
        onChange={(approvedStrokes) => onPatch({ approvedStrokes })}
      />
      <FieldErrors path={`${at}.approvedStrokes`} />

      <div className="cluster">
        <label className="cluster cluster--tight">
          <input type="checkbox" data-testid={`kind-connected-${i}`} checked={Boolean(kind.requireConnection)} onChange={(e) => onPatch({ requireConnection: e.target.checked })} />
          Must be connected
        </label>
        {isC4 && (
          <>
            <label className="cluster cluster--tight" htmlFor={`kind-role-${i}`}>
              C4 role
              <select id={`kind-role-${i}`} data-testid={`kind-role-${i}`} value={kind.match?.role ?? 'system'} onChange={(e) => onPatch({ match: { ...kind.match, role: e.target.value } })}>
                {C4_ELEMENT_ROLES.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </label>
            <label className="cluster cluster--tight">
              <input type="checkbox" data-testid={`kind-external-${i}`} checked={Boolean(kind.match?.external)} onChange={(e) => onPatch({ match: { role: kind.match?.role ?? 'system', external: e.target.checked } })} />
              External
            </label>
            <FieldErrors path={`${at}.match`} />
          </>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn--tertiary-danger btn--compact" data-testid={`kind-remove-${i}`} onClick={onRemove}>
          Remove kind
        </button>
      </div>
    </div>
  );
}

interface SwatchesProps {
  label: string;
  testId: string;
  values: string[];
  onChange: (values: string[]) => void;
}

function Swatches({ label, testId, values, onChange }: SwatchesProps) {
  const [draft, setDraft] = useState('#4f46e5');
  const valid = HEX.test(draft);
  const picker = /^#[0-9a-fA-F]{6}$/.test(draft) ? draft : '#000000';
  const add = () => {
    if (!valid || values.includes(draft)) return;
    onChange([...values, draft]);
  };
  return (
    <fieldset className="std-fieldset" data-testid={testId}>
      <legend className="field__label">{label}</legend>
      <ul className="cluster std-swatches">
        {values.map((value, idx) => (
          <li key={value} className="std-chip" data-testid={`${testId}-chip-${idx}`}>
            <span className="std-swatch" style={{ background: value }} aria-hidden="true" />
            <span className="mono">{value}</span>
            {idx === 0 && <span className="pill">default</span>}
            {idx > 0 && (
              <button type="button" className="btn btn--tertiary btn--compact" aria-label={`Make ${value} the default`} onClick={() => onChange([value, ...values.filter((v) => v !== value)])}>
                Make default
              </button>
            )}
            <button type="button" className="std-chip-x" data-testid={`${testId}-remove-${idx}`} aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((v) => v !== value))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="cluster">
        <input type="color" aria-label={`${label}: pick a color`} data-testid={`${testId}-picker`} value={picker} onChange={(e) => setDraft(e.target.value)} />
        <input aria-label={`${label}: hex value`} data-testid={`${testId}-hex`} className="mono std-hex" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="button" className="btn btn--secondary btn--compact" data-testid={`${testId}-add`} disabled={!valid} onClick={add}>
          Add color
        </button>
        {!valid && <span className="field__error">Use #rgb or #rrggbb.</span>}
      </div>
    </fieldset>
  );
}
