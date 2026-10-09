import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type DiagramTypeDto, type StandardDto } from '../app/api';
import { ConfirmDialog } from '../canvas/ConfirmDialog';
import { DiagramTypeDialog } from './DiagramTypeDialog';
import { StandardsEditor } from './StandardsEditor';

const STATUS_LABEL: Record<StandardDto['status'], string> = { draft: 'Draft', published: 'Published', retired: 'Retired' };

function fmt(date: string | null): string {
  return date ? new Date(date).toLocaleDateString() : '';
}

/**
 * Admin console: pick a diagram type, see its standard versions, and create / edit / clone /
 * publish / retire them. Custom diagram types are created and edited from here too.
 */
export function StandardsAdminPage() {
  const [types, setTypes] = useState<DiagramTypeDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [standards, setStandards] = useState<StandardDto[]>([]);
  const [editing, setEditing] = useState<{ standard?: StandardDto } | null>(null);
  const [typeDialog, setTypeDialog] = useState<{ diagramType?: DiagramTypeDto } | null>(null);
  const [pendingPublish, setPendingPublish] = useState<StandardDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listDiagramTypes().then(({ diagramTypes }) => {
      setTypes(diagramTypes);
      // ?admin=true historically meant "the flowchart standards editor" -- keep that default.
      setSelectedId((current) => current ?? diagramTypes.find((t) => t.id === 'flowchart')?.id ?? diagramTypes[0]?.id ?? null);
    });
  }, []);

  const refresh = useCallback(() => {
    if (!selectedId) return Promise.resolve();
    return api.listStandards(selectedId).then(({ standards }) => setStandards(standards));
  }, [selectedId]);

  useEffect(() => {
    setStandards([]);
    setEditing(null);
    void refresh();
  }, [refresh]);

  const selected = types.find((t) => t.id === selectedId) ?? null;
  const active = standards.find((s) => s.status === 'published') ?? null;

  const grouped = useMemo(() => {
    const groups = new Map<string, DiagramTypeDto[]>();
    for (const type of types) groups.set(type.dslFamily, [...(groups.get(type.dslFamily) ?? []), type]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [types]);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const newDraft = (cloneActive: boolean) =>
    cloneActive && active
      ? run(async () => {
          const { standard } = await api.cloneStandard(active.id);
          await refresh();
          setEditing({ standard });
        }, `Cloned v${active.version} to a new draft.`)
      : setEditing({});

  if (editing && selected) {
    return (
      <StandardsEditor
        diagramType={selected}
        standard={editing.standard}
        onCancel={() => {
          setEditing(null);
          void refresh();
        }}
        onDone={(msg) => {
          setEditing(null);
          setMessage(msg);
          void refresh();
        }}
      />
    );
  }

  return (
    <div>
      <h2>Standards</h2>
      <div className="std-layout">
        <section className="std-types" aria-label="Diagram types">
          <div className="row">
            <span className="section-label spacer">Diagram types</span>
            <button
              type="button"
              className="btn btn--secondary btn--compact"
              data-testid="diagram-type-new"
              onClick={() => setTypeDialog({})}
            >
              New diagram type
            </button>
          </div>
          {grouped.map(([family, list]) => (
            <div key={family}>
              <h3 className="section-label std-types__family">{family}</h3>
              <ul className="std-types__list">
                {list.map((type) => (
                  <li key={type.id}>
                    <button
                      type="button"
                      className="std-types__item"
                      data-testid={`standards-type-${type.id}`}
                      aria-current={type.id === selectedId ? 'true' : undefined}
                      onClick={() => setSelectedId(type.id)}
                    >
                      <span>{type.name}</span>
                      <span className="pill">{type.origin === 'custom' ? 'Custom' : 'Built-in'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <section aria-label="Standard versions">
          {selected ? (
            <>
              <div className="cluster std-header">
                <h3 data-testid="standards-selected-type">{selected.name}</h3>
                <span className="meta">{selected.dslFamily} family</span>
                {selected.origin === 'custom' && (
                  <button
                    type="button"
                    className="btn btn--tertiary btn--compact"
                    data-testid="diagram-type-edit"
                    onClick={() => setTypeDialog({ diagramType: selected })}
                  >
                    Edit type
                  </button>
                )}
                <span className="spacer" />
                {active && (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    data-testid="standard-new-from-active"
                    onClick={() => newDraft(true)}
                  >
                    New draft from active
                  </button>
                )}
                <button type="button" className="btn btn--primary" data-testid="standard-new" onClick={() => newDraft(false)}>
                  New standard
                </button>
              </div>
              {selected.description && <p className="meta">{selected.description}</p>}
              {message && (
                <p role="status" data-testid="standards-editor-message">
                  {message}
                </p>
              )}
              {error && (
                <p role="alert" className="field__error" data-testid="standards-error">
                  {error}
                </p>
              )}
              {standards.length === 0 ? (
                <p className="meta" data-testid="standards-empty">
                  No standards yet for this diagram type. Diagrams of this type are unchecked until one is published.
                </p>
              ) : (
                <ul className="card" data-testid="standards-history">
                  {standards.map((standard) => (
                    <li key={standard.id} className="row" data-testid={`standard-row-${standard.id}`}>
                      <span className="row__main">
                        <span className="row__title">
                          {standard.name ?? `${standard.diagramTypeId} v${standard.version}`}{' '}
                          <span className="meta">v{standard.version}</span>{' '}
                          <span className="pill" data-testid={`standard-status-${standard.id}`}>
                            {STATUS_LABEL[standard.status]}
                          </span>
                        </span>
                        {standard.description && <span className="meta">{standard.description}</span>}
                        <span className="meta" data-testid={`standard-dates-${standard.id}`}>
                          Created {fmt(standard.createdAt)}
                          {standard.publishedAt && ` · Published ${fmt(standard.publishedAt)}`}
                          {standard.retiredAt && ` · Retired ${fmt(standard.retiredAt)}`}
                        </span>
                      </span>
                      <span className="row__actions">
                        {standard.status === 'draft' && (
                          <>
                            <button
                              type="button"
                              className="btn btn--tertiary btn--compact"
                              data-testid={`standard-edit-${standard.id}`}
                              onClick={() => setEditing({ standard })}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn--tertiary btn--compact"
                              data-testid={`standard-publish-${standard.id}`}
                              onClick={() => setPendingPublish(standard)}
                            >
                              Publish
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="btn btn--tertiary btn--compact"
                          data-testid={`standard-clone-${standard.id}`}
                          onClick={() =>
                            run(async () => {
                              const { standard: clone } = await api.cloneStandard(standard.id);
                              await refresh();
                              setEditing({ standard: clone });
                            }, `Cloned v${standard.version} to a new draft.`)
                          }
                        >
                          Clone to new draft
                        </button>
                        {standard.status === 'published' && (
                          <button
                            type="button"
                            className="btn btn--tertiary-danger btn--compact"
                            data-testid={`retire-standard-${standard.id}`}
                            onClick={() => run(() => api.retireStandard(standard.id), `Retired v${standard.version}.`)}
                          >
                            Retire
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p>Loading…</p>
          )}
        </section>
      </div>

      {typeDialog && (
        <DiagramTypeDialog
          diagramType={typeDialog.diagramType}
          onClose={() => setTypeDialog(null)}
          onSaved={(saved) => {
            setTypeDialog(null);
            setTypes((prev) => (prev.some((t) => t.id === saved.id) ? prev.map((t) => (t.id === saved.id ? saved : t)) : [...prev, saved]));
            setSelectedId(saved.id);
          }}
        />
      )}
      {pendingPublish && (
        <ConfirmDialog
          message={`Publish "${pendingPublish.name ?? `v${pendingPublish.version}`}"? It becomes the active standard and existing diagrams of this type will be re-checked against it.`}
          onCancel={() => setPendingPublish(null)}
          onConfirm={() => {
            const target = pendingPublish;
            setPendingPublish(null);
            void run(() => api.publishStandard(target.id), `Published standard v${target.version}.`);
          }}
        />
      )}
    </div>
  );
}
