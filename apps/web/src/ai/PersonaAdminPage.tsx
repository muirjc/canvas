import { useEffect, useState } from 'react';
import { api, ApiError, type AiPersonaDto, type AiSettingsDto } from '../app/api';
import { groupPersonasByCategory } from './persona-grouping';

const CATEGORIES = ['Business', 'Enterprise', 'Solution', 'Technical'] as const;

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

  const refresh = () => {
    api.listAllAiPersonas().then(({ personas }) => setPersonas(personas));
  };

  useEffect(() => {
    refresh();
    api.getAiSettings().then(setSettings);
  }, []);

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
    </div>
  );
}
