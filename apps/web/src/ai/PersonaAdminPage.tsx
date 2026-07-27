import { useEffect, useState } from 'react';
import { api, ApiError, type AiPersonaDto, type AiSettingsDto } from '../app/api';

const CATEGORIES = ['Business', 'Enterprise', 'Solution', 'Technical'] as const;

function groupByCategory(personas: AiPersonaDto[]): Map<string, AiPersonaDto[]> {
  const groups = new Map<string, AiPersonaDto[]>();
  for (const persona of personas) {
    const list = groups.get(persona.category) ?? [];
    list.push(persona);
    groups.set(persona.category, list);
  }
  return groups;
}

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

  const handlePromptEdit = async (id: string, newSystemPrompt: string, previous: string) => {
    if (newSystemPrompt === previous) return;
    await api.updateAiPersona(id, { systemPrompt: newSystemPrompt });
    refresh();
  };

  const handleToggleChat = async (chatEnabled: boolean) => {
    setSettings(await api.setAiSettings({ chatEnabled }));
  };

  const groups = groupByCategory(personas);

  return (
    <div>
      <h2>AI Personas</h2>

      <label>
        <input
          type="checkbox"
          data-testid="ai-chat-enabled-toggle"
          checked={settings?.chatEnabled ?? false}
          onChange={(e) => handleToggleChat(e.target.checked)}
        />
        Enable AI Chat
      </label>

      {CATEGORIES.map((cat) => {
        const categoryPersonas = groups.get(cat) ?? [];
        return (
          <div key={cat}>
            <h3>{cat}</h3>
            <ul>
              {categoryPersonas.map((persona) => (
                <li key={persona.id} data-testid={`persona-row-${persona.id}`}>
                  <strong>{persona.name}</strong> <span data-testid={`persona-status-${persona.id}`}>({persona.status})</span>
                  <textarea
                    data-testid={`persona-prompt-${persona.id}`}
                    aria-label={`System prompt for ${persona.name}`}
                    defaultValue={persona.systemPrompt}
                    onBlur={(e) => handlePromptEdit(persona.id, e.target.value, persona.systemPrompt)}
                    rows={3}
                    cols={50}
                  />
                  {persona.status === 'active' && (
                    <button
                      type="button"
                      data-testid={`persona-archive-${persona.id}`}
                      onClick={() => handleArchive(persona.id)}
                    >
                      Archive
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      <h3>Create Persona</h3>
      <label>
        Name
        <input data-testid="persona-create-name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Category
        <select data-testid="persona-create-category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        System Prompt
        <textarea
          data-testid="persona-create-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          cols={50}
        />
      </label>
      <button
        type="button"
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
  );
}
