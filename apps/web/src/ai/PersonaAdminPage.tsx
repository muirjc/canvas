import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type AiPersonaDto,
  type AiProviderKind,
  type AiSettingsDto,
  type PersonaReferenceMaterialDto,
} from '../app/api';
import { groupPersonasByCategory } from './persona-grouping';
import { ConfirmDialog } from '../canvas/ConfirmDialog';

const CATEGORIES = ['Business', 'Enterprise', 'Solution', 'Technical'] as const;

// 010-ai-diagram-knowledge, User Story 4: the 6 registered diagram-type family ids a reference-
// material entry can be scoped to (empty selection = unscoped, applies to every diagram type).
// Fixed/complete per packages/diagram-core/src/dsl/registry.ts -- no need to fetch dynamically.
const DIAGRAM_FAMILIES = ['flowchart', 'c4', 'architecture', 'sequence', 'erd', 'uml'] as const;

type ReferenceMaterialDraft = { content: string; diagramFamilies: string[] };

// canvas-wuc: lets an admin self-diagnose the exact drift that motivated this bead — a real
// deployment unexpectedly running the mock/placeholder provider (or none configured at all).
const PROVIDER_LABEL: Record<AiProviderKind, string> = {
  anthropic: 'Anthropic (live)',
  openai: 'OpenAI (live)',
  mock: 'Mock / test provider — responses are simulated, not from a real AI model',
  unconfigured: 'Not configured — AI requests will fail',
};

/** User Story 3: admin persona library management (create/edit/archive), plus the platform-wide
 * "Enable AI Chat" toggle (FR-020) — tasks.md has no dedicated task for that toggle's admin UI,
 * only its backend routes (T009), so it's folded in here rather than getting its own screen. */
export function PersonaAdminPage() {
  const [personas, setPersonas] = useState<AiPersonaDto[]>([]);
  const [settings, setSettings] = useState<AiSettingsDto | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  // canvas-rbu: hidden by default -- the bead's own complaint is archived entries cluttering the
  // screen as the library grows, so the reduce-clutter direction is the more useful default. A
  // persona's status is still shown via the existing persona-status-<id> badge when this is on.
  const [showArchived, setShowArchived] = useState(false);
  // canvas-ddx: the prompt textareas used to be uncontrolled (defaultValue) and commit silently on
  // blur -- no explicit action, no save-state feedback, unlike every other edit surface in this
  // app (diagram Save button, standards editor). Now controlled per-persona: `drafts` holds only
  // entries a user has actually typed into (a persona with none falls back to its own
  // systemPrompt), so a persona is "dirty" purely by comparing the two -- refreshing the list after
  // a successful save naturally clears dirty state without needing to separately reset `drafts`,
  // since the fetched systemPrompt then matches what was just typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<{ id: string; message: string } | null>(null);

  // 010-ai-diagram-knowledge, User Story 4: reference-material CRUD per persona, mirroring the
  // system-prompt drafts/savingId/savedId/*Error pattern directly above -- but keyed by entry id
  // (not persona id) since a persona can have several entries at once, each independently dirty.
  const [referenceMaterials, setReferenceMaterials] = useState<Record<string, PersonaReferenceMaterialDto[]>>({});
  const [entryDrafts, setEntryDrafts] = useState<Record<string, ReferenceMaterialDraft>>({});
  const [entrySavingId, setEntrySavingId] = useState<string | null>(null);
  const [entrySavedId, setEntrySavedId] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<{ id: string; message: string } | null>(null);
  // canvas-40t precedent: deleting reuses the app's dedicated Modal-based ConfirmDialog, not
  // window.confirm (this app has no window.confirm anywhere -- see ProjectBrowser's diagram
  // delete flow), and clears/reports the error the same way if the request fails.
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<{ personaId: string; entryId: string } | null>(null);
  const [entryDeleteError, setEntryDeleteError] = useState<string | null>(null);
  // "Add reference material" mini-form draft, one per persona (a persona's own row is only ever
  // visible once, so no risk of two forms racing each other for the same persona).
  const [newEntryDrafts, setNewEntryDrafts] = useState<Record<string, ReferenceMaterialDraft>>({});
  const [createEntryError, setCreateEntryError] = useState<{ personaId: string; message: string } | null>(null);

  const refresh = () => {
    api.listAllAiPersonas().then(({ personas }) => setPersonas(personas));
  };

  const refreshReferenceMaterial = (personaId: string) => {
    api.listPersonaReferenceMaterial(personaId).then(({ entries }) => {
      setReferenceMaterials((prev) => ({ ...prev, [personaId]: entries }));
    });
  };

  useEffect(() => {
    refresh();
    api.getAiSettings().then(setSettings);
  }, []);

  // Lazily fetches each persona's reference material the first time it appears in the list --
  // once per persona id, not re-fetched on every refresh() (e.g. after an unrelated archive).
  useEffect(() => {
    personas.forEach((persona) => {
      if (!(persona.id in referenceMaterials)) {
        refreshReferenceMaterial(persona.id);
      }
    });
  }, [personas]);

  const entryContent = (entry: PersonaReferenceMaterialDto) => entryDrafts[entry.id]?.content ?? entry.content;
  const entryFamilies = (entry: PersonaReferenceMaterialDto) =>
    entryDrafts[entry.id]?.diagramFamilies ?? entry.diagramFamilies;
  const isEntryDirty = (entry: PersonaReferenceMaterialDto) => {
    const draft = entryDrafts[entry.id];
    if (!draft) return false;
    if (draft.content !== entry.content) return true;
    const before = [...entry.diagramFamilies].sort();
    const after = [...draft.diagramFamilies].sort();
    return before.length !== after.length || before.some((family, i) => family !== after[i]);
  };

  const setEntryDraft = (entry: PersonaReferenceMaterialDto, patch: Partial<ReferenceMaterialDraft>) => {
    setEntryDrafts((prev) => {
      const current = prev[entry.id] ?? { content: entry.content, diagramFamilies: entry.diagramFamilies };
      return { ...prev, [entry.id]: { ...current, ...patch } };
    });
    setEntrySavedId((current) => (current === entry.id ? null : current));
  };

  const toggleEntryFamily = (entry: PersonaReferenceMaterialDto, family: string, checked: boolean) => {
    const current = entryFamilies(entry);
    const next = checked ? [...current, family] : current.filter((f) => f !== family);
    setEntryDraft(entry, { diagramFamilies: next });
  };

  const handleEntrySave = async (personaId: string, entry: PersonaReferenceMaterialDto) => {
    if (!isEntryDirty(entry)) return;
    setEntrySavingId(entry.id);
    setEntrySavedId(null);
    setEntryError(null);
    try {
      await api.updatePersonaReferenceMaterial(personaId, entry.id, {
        content: entryContent(entry),
        diagramFamilies: entryFamilies(entry),
      });
      refreshReferenceMaterial(personaId);
      setEntrySavedId(entry.id);
    } catch (err) {
      setEntryError({ id: entry.id, message: err instanceof ApiError ? err.message : (err as Error).message });
    } finally {
      setEntrySavingId((current) => (current === entry.id ? null : current));
    }
  };

  const requestEntryDelete = (personaId: string, entryId: string) => {
    setPendingDeleteEntry({ personaId, entryId });
  };

  const confirmEntryDelete = async () => {
    if (!pendingDeleteEntry) return;
    const { personaId, entryId } = pendingDeleteEntry;
    setEntryDeleteError(null);
    try {
      await api.deletePersonaReferenceMaterial(personaId, entryId);
      setPendingDeleteEntry(null);
      refreshReferenceMaterial(personaId);
    } catch (err) {
      setPendingDeleteEntry(null);
      setEntryDeleteError(err instanceof ApiError ? err.message : 'Failed to delete reference material.');
    }
  };

  const newEntryDraft = (personaId: string): ReferenceMaterialDraft =>
    newEntryDrafts[personaId] ?? { content: '', diagramFamilies: [] };

  const setNewEntryDraft = (personaId: string, patch: Partial<ReferenceMaterialDraft>) => {
    setNewEntryDrafts((prev) => ({ ...prev, [personaId]: { ...newEntryDraft(personaId), ...patch } }));
  };

  const toggleNewEntryFamily = (personaId: string, family: string, checked: boolean) => {
    const current = newEntryDraft(personaId).diagramFamilies;
    const next = checked ? [...current, family] : current.filter((f) => f !== family);
    setNewEntryDraft(personaId, { diagramFamilies: next });
  };

  const handleCreateEntry = async (personaId: string) => {
    const draft = newEntryDraft(personaId);
    if (!draft.content.trim()) return;
    setCreateEntryError(null);
    try {
      await api.createPersonaReferenceMaterial(personaId, {
        content: draft.content,
        diagramFamilies: draft.diagramFamilies,
      });
      setNewEntryDrafts((prev) => {
        const next = { ...prev };
        delete next[personaId];
        return next;
      });
      refreshReferenceMaterial(personaId);
    } catch (err) {
      setCreateEntryError({
        personaId,
        message: err instanceof ApiError ? err.message : (err as Error).message,
      });
    }
  };

  const handleCreate = async () => {
    setError(null);
    try {
      await api.createAiPersona({ name, category, systemPrompt });
      setName('');
      setSystemPrompt('');
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const handleArchive = async (id: string) => {
    await api.archiveAiPersona(id);
    refresh();
  };

  const promptValue = (persona: AiPersonaDto) => drafts[persona.id] ?? persona.systemPrompt;
  const isPromptDirty = (persona: AiPersonaDto) => promptValue(persona) !== persona.systemPrompt;

  const handlePromptSave = async (persona: AiPersonaDto) => {
    const value = promptValue(persona);
    if (value === persona.systemPrompt) return;
    setSavingId(persona.id);
    setSavedId(null);
    setPromptError(null);
    try {
      await api.updateAiPersona(persona.id, { systemPrompt: value });
      refresh();
      setSavedId(persona.id);
    } catch (err) {
      setPromptError({ id: persona.id, message: err instanceof ApiError ? err.message : (err as Error).message });
    } finally {
      setSavingId((current) => (current === persona.id ? null : current));
    }
  };

  const handleToggleChat = async (chatEnabled: boolean) => {
    setSettings(await api.setAiSettings({ chatEnabled }));
  };

  const visiblePersonas = showArchived ? personas : personas.filter((p) => p.status !== 'archived');
  const archivedCount = personas.length - personas.filter((p) => p.status !== 'archived').length;
  const groups = groupPersonasByCategory(visiblePersonas);

  return (
    <div className="stack">
      <h2>AI Personas</h2>

      {/* canvas-23t.1: every section below reuses primitives already established elsewhere
          (SharedDiagramsList, ProjectBrowser, StandardsEditor) — .card for a bordered surface,
          .row/.row__main/.row__title/.row__actions for a single-line entry, .field for a
          labelled control — rather than inventing a bespoke persona layout. */}
      <section className="card">
        <label className="row">
          <input
            type="checkbox"
            data-testid="ai-chat-enabled-toggle"
            checked={settings?.chatEnabled ?? false}
            onChange={(e) => handleToggleChat(e.target.checked)}
          />
          Enable AI Chat
        </label>
        {settings && (
          <p className="meta" data-testid="ai-provider-indicator">
            Provider: {PROVIDER_LABEL[settings.provider]}
          </p>
        )}
        {archivedCount > 0 && (
          <label className="row">
            <input
              type="checkbox"
              data-testid="show-archived-personas-toggle"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived personas ({archivedCount})
          </label>
        )}
      </section>

      {CATEGORIES.map((cat) => {
        const categoryPersonas = groups.get(cat) ?? [];
        return (
          <section key={cat}>
            <h3 className="section-label">{cat}</h3>
            <ul className="project-node__list stack">
              {categoryPersonas.map((persona) => (
                <li key={persona.id} data-testid={`persona-row-${persona.id}`} className="card">
                  <div className="row">
                    <span className="row__main">
                      <span className="row__title">
                        <strong>{persona.name}</strong>{' '}
                        <span className="meta" data-testid={`persona-status-${persona.id}`}>
                          ({persona.status})
                        </span>
                      </span>
                    </span>
                    <span className="row__actions">
                      {persona.status === 'active' && (
                        <button
                          type="button"
                          className="btn btn--tertiary btn--compact"
                          data-testid={`persona-archive-${persona.id}`}
                          onClick={() => handleArchive(persona.id)}
                        >
                          Archive
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="panel__body">
                    <textarea
                      data-testid={`persona-prompt-${persona.id}`}
                      aria-label={`System prompt for ${persona.name}`}
                      value={promptValue(persona)}
                      onChange={(e) => {
                        setDrafts((prev) => ({ ...prev, [persona.id]: e.target.value }));
                        setSavedId((current) => (current === persona.id ? null : current));
                      }}
                      rows={3}
                      style={{ width: '100%' }}
                    />
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--primary btn--compact"
                        data-testid={`persona-prompt-save-${persona.id}`}
                        disabled={!isPromptDirty(persona) || savingId === persona.id}
                        onClick={() => handlePromptSave(persona)}
                      >
                        {savingId === persona.id ? 'Saving…' : 'Save'}
                      </button>
                      {isPromptDirty(persona) && (
                        <span className="meta" data-testid={`persona-prompt-status-${persona.id}`}>
                          Unsaved changes
                        </span>
                      )}
                      {!isPromptDirty(persona) && savedId === persona.id && (
                        <span className="meta" data-testid={`persona-prompt-status-${persona.id}`}>
                          Saved
                        </span>
                      )}
                    </div>
                    {promptError?.id === persona.id && (
                      <p role="alert" data-testid={`persona-prompt-error-${persona.id}`}>
                        {promptError.message}
                      </p>
                    )}
                  </div>

                  {/* 010-ai-diagram-knowledge, User Story 4: admin-curated reference material,
                      each entry optionally scoped to specific diagram-type families. Reuses the
                      exact same primitives (.panel__body/.field/.field__label/.row/.meta/.btn)
                      as the system-prompt block directly above it. */}
                  <div className="panel__body" data-testid={`reference-material-section-${persona.id}`}>
                    <h4 className="section-label">Reference Material</h4>
                    <ul className="stack">
                      {(referenceMaterials[persona.id] ?? []).map((entry) => (
                        <li key={entry.id} data-testid={`reference-material-row-${entry.id}`} className="card">
                          <div className="field">
                            <label className="field__label" htmlFor={`reference-material-content-${entry.id}`}>
                              Content
                            </label>
                            <textarea
                              id={`reference-material-content-${entry.id}`}
                              data-testid={`reference-material-content-${entry.id}`}
                              value={entryContent(entry)}
                              onChange={(e) => setEntryDraft(entry, { content: e.target.value })}
                              rows={3}
                              style={{ width: '100%' }}
                            />
                          </div>
                          <fieldset>
                            <legend className="field__label">Applies to diagram types (none = all)</legend>
                            {DIAGRAM_FAMILIES.map((family) => (
                              <label key={family} className="row">
                                <input
                                  type="checkbox"
                                  data-testid={`reference-material-family-${entry.id}-${family}`}
                                  checked={entryFamilies(entry).includes(family)}
                                  onChange={(e) => toggleEntryFamily(entry, family, e.target.checked)}
                                />
                                {family}
                              </label>
                            ))}
                          </fieldset>
                          <div className="row">
                            <button
                              type="button"
                              className="btn btn--primary btn--compact"
                              data-testid={`reference-material-save-${entry.id}`}
                              disabled={!isEntryDirty(entry) || entrySavingId === entry.id}
                              onClick={() => handleEntrySave(persona.id, entry)}
                            >
                              {entrySavingId === entry.id ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              className="btn btn--tertiary btn--compact"
                              data-testid={`reference-material-delete-${entry.id}`}
                              onClick={() => requestEntryDelete(persona.id, entry.id)}
                            >
                              Delete
                            </button>
                            {isEntryDirty(entry) && (
                              <span className="meta" data-testid={`reference-material-status-${entry.id}`}>
                                Unsaved changes
                              </span>
                            )}
                            {!isEntryDirty(entry) && entrySavedId === entry.id && (
                              <span className="meta" data-testid={`reference-material-status-${entry.id}`}>
                                Saved
                              </span>
                            )}
                          </div>
                          {entryError?.id === entry.id && (
                            <p role="alert" data-testid={`reference-material-error-${entry.id}`}>
                              {entryError.message}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>

                    <div className="field">
                      <label className="field__label" htmlFor={`reference-material-create-content-${persona.id}`}>
                        Add reference material
                      </label>
                      <textarea
                        id={`reference-material-create-content-${persona.id}`}
                        data-testid={`reference-material-create-content-${persona.id}`}
                        value={newEntryDraft(persona.id).content}
                        onChange={(e) => setNewEntryDraft(persona.id, { content: e.target.value })}
                        rows={3}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <fieldset>
                      <legend className="field__label">Applies to diagram types (none = all)</legend>
                      {DIAGRAM_FAMILIES.map((family) => (
                        <label key={family} className="row">
                          <input
                            type="checkbox"
                            data-testid={`reference-material-create-family-${persona.id}-${family}`}
                            checked={newEntryDraft(persona.id).diagramFamilies.includes(family)}
                            onChange={(e) => toggleNewEntryFamily(persona.id, family, e.target.checked)}
                          />
                          {family}
                        </label>
                      ))}
                    </fieldset>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--primary btn--compact"
                        data-testid={`reference-material-create-submit-${persona.id}`}
                        disabled={!newEntryDraft(persona.id).content.trim()}
                        onClick={() => handleCreateEntry(persona.id)}
                      >
                        Add Reference Material
                      </button>
                    </div>
                    {createEntryError?.personaId === persona.id && (
                      <p role="alert" data-testid={`reference-material-create-error-${persona.id}`}>
                        {createEntryError.message}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className="card">
        <div className="panel__body">
          <h3 className="section-label">Create Persona</h3>
          <div className="field">
            <label className="field__label" htmlFor="persona-create-name">
              Name
            </label>
            <input
              id="persona-create-name"
              data-testid="persona-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="persona-create-category">
              Category
            </label>
            <select
              id="persona-create-category"
              data-testid="persona-create-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="persona-create-prompt">
              System Prompt
            </label>
            <textarea
              id="persona-create-prompt"
              data-testid="persona-create-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
            />
          </div>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="persona-create-submit"
            disabled={!name || !systemPrompt}
            onClick={handleCreate}
          >
            Create Persona
          </button>
          {error && (
            <p role="alert" data-testid="persona-create-error">
              {error}
            </p>
          )}
        </div>
      </section>

      {entryDeleteError && (
        <p role="alert" data-testid="reference-material-delete-error">
          {entryDeleteError}
        </p>
      )}
      {pendingDeleteEntry && (
        <ConfirmDialog
          message="Delete this reference material entry? This cannot be undone."
          onConfirm={confirmEntryDelete}
          onCancel={() => setPendingDeleteEntry(null)}
        />
      )}
    </div>
  );
}
